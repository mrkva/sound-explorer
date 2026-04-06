/**
 * Spectrogram renderer — manages canvas, FFT workers, tile cache, interaction.
 */

import { WavParser } from './wav-parser.js?v=3';

const MARGIN_LEFT = 50;
const MARGIN_BOTTOM = 40;

const CURSOR_COLORS = {
  viridis: '#f15656',
  magma: '#f15656',
  inferno: '#f15656',
  grayscale: '#f15656',
  green: '#f15656',
  hot: '#00ffff',
};

export class SpectrogramRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // DOM cursor line (CSS transform — zero canvas/layout cost)
    this._cursorEl = null;
    this.wavInfo = null;
    this.files = []; // array of parsed wav infos for multi-file timeline
    this.totalSamples = 0;
    this.totalDuration = 0;

    // View state
    this.viewStart = 0;    // sample offset
    this.viewEnd = 0;      // sample offset
    this.fftSize = 2048;
    this.dbMin = -100;
    this.dbMax = -20;
    this.colormap = 'viridis';
    this.freqMin = 0;
    this.freqMax = 0;      // set from sampleRate
    this.logScale = false;
    this.channel = 'mix';

    // Selection
    this.selectionStart = null;
    this.selectionEnd = null;

    // Playback cursor
    this._lastPlaybackTime = null;

    // Tile cache
    this._tileCache = new Map();
    this._maxTiles = 200;

    // Workers
    this._fftWorkers = [];
    this._renderWorker = null;
    this._workerIdCounter = 0;
    this._pendingFFT = new Map();
    this._pendingRender = new Map();

    // Interaction state
    this._isDragging = false;
    this._dragButton = -1;
    this._dragStartX = 0;
    this._dragStartViewStart = 0;
    this._dragStartViewEnd = 0;
    this._lastBitmap = null;

    // Callbacks
    this.onSeek = null;
    this.onSelectionChange = null;
    this.onCursorMove = null;

    this._initWorkers();
    this._initInteraction();
  }

  _initWorkers() {
    const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 8);
    for (let i = 0; i < numWorkers; i++) {
      const w = new Worker('js/fft-worker.js');
      w.onmessage = (e) => this._onFFTResult(e.data);
      this._fftWorkers.push(w);
    }
    this._nextWorker = 0;

    this._renderWorker = new Worker('js/render-worker.js');
    this._renderWorker.onmessage = (e) => this._onRenderResult(e.data);
  }

  _initInteraction() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._onWheel(e);
    }, { passive: false });

    c.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        // Left click — selection or seek
        this._isDragging = true;
        this._dragButton = 0;
        this._dragStartX = e.offsetX;
        this._dragMoved = false;
      } else if (e.button === 2) {
        // Right click — pan
        e.preventDefault();
        this._isDragging = true;
        this._dragButton = 2;
        this._dragStartX = e.offsetX;
        this._dragStartViewStart = this.viewStart;
        this._dragStartViewEnd = this.viewEnd;
      }
    });

    c.addEventListener('mousemove', (e) => {
      // Update cursor info
      if (this.wavInfo && this.onCursorMove) {
        const time = this._xToTime(e.offsetX);
        const freq = this._yToFreq(e.offsetY);
        if (time !== null && freq !== null) {
          this.onCursorMove(time, freq);
        }
      }

      if (!this._isDragging) return;

      if (this._dragButton === 0) {
        const dx = Math.abs(e.offsetX - this._dragStartX);
        if (dx > 3) this._dragMoved = true;
        if (this._dragMoved) {
          const t1 = this._xToTime(this._dragStartX);
          const t2 = this._xToTime(e.offsetX);
          if (t1 !== null && t2 !== null) {
            this.selectionStart = Math.min(t1, t2);
            this.selectionEnd = Math.max(t1, t2);
            this._drawOverlays();
            if (this.onSelectionChange) {
              this.onSelectionChange(this.selectionStart, this.selectionEnd);
            }
          }
        }
      } else if (this._dragButton === 2) {
        const dx = e.offsetX - this._dragStartX;
        const w = this.canvas.width - MARGIN_LEFT;
        const viewDuration = this._dragStartViewEnd - this._dragStartViewStart;
        const panSamples = -dx / w * viewDuration;
        let newStart = this._dragStartViewStart + panSamples;
        let newEnd = this._dragStartViewEnd + panSamples;
        if (newStart < 0) { newEnd -= newStart; newStart = 0; }
        if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
        newStart = Math.max(0, newStart);
        this.viewStart = Math.floor(newStart);
        this.viewEnd = Math.floor(newEnd);
        this._scheduleRender();
      }
    });

    c.addEventListener('mouseup', (e) => {
      if (this._isDragging && this._dragButton === 0 && !this._dragMoved) {
        // Click without drag = seek
        const time = this._xToTime(e.offsetX);
        if (time !== null && this.onSeek) {
          this.onSeek(time / this.wavInfo.sampleRate);
        }
      }
      this._isDragging = false;
      this._dragButton = -1;
    });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    // Resize observer
    this._resizeTimer = null;
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      // Immediately stretch old image
      if (this._lastBitmap) {
        this._drawStretched();
      }
      this._resizeTimer = setTimeout(() => {
        this._updateCanvasSize();
        this._tileCache.clear();
        this.render();
      }, 200);
    });
    this._resizeObserver.observe(this.canvas.parentElement);
    this._updateCanvasSize();
  }

  _updateCanvasSize() {
    const parent = this.canvas.parentElement;
    const rect = parent.getBoundingClientRect();
    this.canvas.width = Math.floor(rect.width);
    this.canvas.height = Math.floor(rect.height);
  }

  // --- Coordinate conversion ---

  _xToTime(px) {
    const w = this.canvas.width - MARGIN_LEFT;
    if (px < MARGIN_LEFT || px > this.canvas.width) return null;
    const frac = (px - MARGIN_LEFT) / w;
    return Math.floor(this.viewStart + frac * (this.viewEnd - this.viewStart));
  }

  _timeToX(sample) {
    const w = this.canvas.width - MARGIN_LEFT;
    const frac = (sample - this.viewStart) / (this.viewEnd - this.viewStart);
    return MARGIN_LEFT + frac * w;
  }

  _yToFreq(py) {
    const h = this.canvas.height - MARGIN_BOTTOM;
    if (py < 0 || py > h) return null;
    const frac = 1 - py / h;
    if (this.logScale && this.freqMin > 0) {
      const logMin = Math.log10(this.freqMin);
      const logMax = Math.log10(this.freqMax);
      return Math.pow(10, logMin + frac * (logMax - logMin));
    }
    return this.freqMin + frac * (this.freqMax - this.freqMin);
  }

  // --- Zoom ---

  _wheelTimer = null;

  _onWheel(e) {
    if (!this.wavInfo) return;
    const zoomFactor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
    const viewDuration = this.viewEnd - this.viewStart;
    const newDuration = Math.min(this.totalSamples, Math.max(128, viewDuration * zoomFactor));

    // Center zoom on playback cursor if available, else mouse position
    let centerSample;
    if (this._lastPlaybackTime !== null) {
      centerSample = Math.floor(this._lastPlaybackTime * this.wavInfo.sampleRate);
    } else {
      const mx = this._xToTime(e.offsetX);
      centerSample = mx !== null ? mx : Math.floor((this.viewStart + this.viewEnd) / 2);
    }

    const ratio = (centerSample - this.viewStart) / viewDuration;
    let newStart = centerSample - ratio * newDuration;
    let newEnd = newStart + newDuration;

    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
    newStart = Math.max(0, newStart);

    this.viewStart = Math.floor(newStart);
    this.viewEnd = Math.floor(newEnd);

    // Debounce
    if (this._wheelTimer) clearTimeout(this._wheelTimer);
    this._drawStretched();
    this._wheelTimer = setTimeout(() => this.render(), 150);
  }

  zoomIn() {
    if (!this.wavInfo) return;
    this._zoomBy(1 / 1.5);
  }

  zoomOut() {
    if (!this.wavInfo) return;
    this._zoomBy(1.5);
  }

  fitAll() {
    if (!this.wavInfo) return;
    this.viewStart = 0;
    this.viewEnd = this.totalSamples;
    this.render();
  }

  _zoomBy(factor) {
    const viewDuration = this.viewEnd - this.viewStart;
    const newDuration = Math.min(this.totalSamples, Math.max(128, viewDuration * factor));

    let center;
    if (this._lastPlaybackTime !== null) {
      center = Math.floor(this._lastPlaybackTime * this.wavInfo.sampleRate);
    } else {
      center = Math.floor((this.viewStart + this.viewEnd) / 2);
    }

    const ratio = (center - this.viewStart) / viewDuration;
    let newStart = center - ratio * newDuration;
    let newEnd = newStart + newDuration;

    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
    newStart = Math.max(0, newStart);

    this.viewStart = Math.floor(newStart);
    this.viewEnd = Math.floor(newEnd);
    this.render();
  }

  // --- Loading ---

  setFiles(wavInfos) {
    // Sort by BWF start time if available
    this.files = wavInfos.sort((a, b) => {
      const ta = a.bext ? a.bext.timeReference : 0;
      const tb = b.bext ? b.bext.timeReference : 0;
      return ta - tb;
    });

    // Use first file as reference for sample rate etc
    this.wavInfo = this.files[0];
    this.totalSamples = 0;

    // Build unified timeline — for now each file appended
    for (const f of this.files) {
      f._timelineOffset = this.totalSamples;
      this.totalSamples += f.totalSamples;
    }

    this.totalDuration = this.totalSamples / this.wavInfo.sampleRate;
    this.freqMax = this.wavInfo.sampleRate / 2;
    this.viewStart = 0;
    this.viewEnd = this.totalSamples;
    this.selectionStart = null;
    this.selectionEnd = null;
    this._lastPlaybackTime = null;
    this._tileCache.clear();

    return this.render();
  }

  // --- Rendering pipeline ---

  _renderGeneration = 0;
  _renderTimer = null;

  _scheduleRender() {
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => this.render(), 50);
  }

  async render(playbackTime) {
    if (!this.wavInfo) return;

    if (playbackTime !== undefined) {
      this._lastPlaybackTime = playbackTime;
    }

    const gen = ++this._renderGeneration;
    const w = this.canvas.width - MARGIN_LEFT;
    const h = this.canvas.height - MARGIN_BOTTOM;
    if (w <= 0 || h <= 0) return;

    const viewSamples = this.viewEnd - this.viewStart;
    const targetFrames = Math.min(w * 2, 4000);
    const hopSize = Math.max(64, Math.floor(viewSamples / targetFrames));

    const cacheKey = `${this.viewStart}-${this.viewEnd}-${this.fftSize}-${targetFrames}-${this.channel}`;

    // Check tile cache
    const cached = this._tileCache.get(cacheKey);
    if (cached) {
      this._renderFromMagnitudes(cached.magnitudes, cached.numFrames, cached.halfFFT, w, h, gen);
      return;
    }

    // Read PCM data for visible range
    const channel = this.channel === 'mix' ? 'mix' : parseInt(this.channel);

    // Handle split view
    if (typeof this.channel === 'string' && this.channel.includes('|')) {
      await this._renderSplitView(gen);
      return;
    }

    // Determine if we need subsampled mode
    const useSubsampled = viewSamples > 16_000_000;

    try {
      let samples;
      if (useSubsampled) {
        samples = await this._readSubsampled(this.viewStart, this.viewEnd, targetFrames * this.fftSize / viewSamples, channel);
      } else {
        // Find which file(s) contain this range
        samples = await this._readSamplesRange(this.viewStart, this.viewEnd, channel);
      }

      if (gen !== this._renderGeneration) return; // stale

      // Dispatch to FFT worker
      const workerId = this._workerIdCounter++;
      const worker = this._fftWorkers[this._nextWorker % this._fftWorkers.length];
      this._nextWorker++;

      const promise = new Promise((resolve) => {
        this._pendingFFT.set(workerId, resolve);
      });

      worker.postMessage({
        samples: samples.buffer,
        fftSize: this.fftSize,
        hopSize,
        id: workerId,
      }, [samples.buffer]);

      const fftResult = await promise;
      if (gen !== this._renderGeneration) return;

      // Cache
      if (this._tileCache.size >= this._maxTiles) {
        const firstKey = this._tileCache.keys().next().value;
        this._tileCache.delete(firstKey);
      }
      this._tileCache.set(cacheKey, {
        magnitudes: new Float32Array(fftResult.magnitudes).buffer,
        numFrames: fftResult.numFrames,
        halfFFT: fftResult.halfFFT,
      });

      this._renderFromMagnitudes(fftResult.magnitudes, fftResult.numFrames, fftResult.halfFFT, w, h, gen);
    } catch (err) {
      console.error('Spectrogram render error:', err);
    }
  }

  async _readSamplesRange(startSample, endSample, channel) {
    const numSamples = endSample - startSample;
    const result = new Float32Array(numSamples);
    let outPos = 0;

    for (const f of this.files) {
      const fileStart = f._timelineOffset;
      const fileEnd = fileStart + f.totalSamples;

      if (startSample >= fileEnd || endSample <= fileStart) continue;

      const readStart = Math.max(0, startSample - fileStart);
      const readEnd = Math.min(f.totalSamples, endSample - fileStart);
      const count = readEnd - readStart;

      // Read in chunks of 8MB
      const maxChunkSamples = Math.floor(8 * 1024 * 1024 / f.blockAlign);
      for (let pos = readStart; pos < readEnd; pos += maxChunkSamples) {
        const chunkCount = Math.min(maxChunkSamples, readEnd - pos);
        const raw = await WavParser.readSamples(f, pos, chunkCount);
        const decoded = WavParser.decodeSamples(raw, f, channel);
        result.set(decoded, outPos);
        outPos += decoded.length;
      }
    }

    return result;
  }

  async _readSubsampled(startSample, endSample, density, channel) {
    const viewSamples = endSample - startSample;
    const numWindows = Math.min(4000, Math.ceil(viewSamples * density));
    const windowSpacing = viewSamples / numWindows;
    const samplesPerWindow = this.fftSize;

    const result = new Float32Array(numWindows * samplesPerWindow);

    for (let i = 0; i < numWindows; i++) {
      const center = startSample + i * windowSpacing;
      const readStart = Math.max(0, Math.floor(center - samplesPerWindow / 2));
      const readCount = Math.min(samplesPerWindow, this.totalSamples - readStart);

      // Find the file containing this position
      for (const f of this.files) {
        const fileStart = f._timelineOffset;
        const fileEnd = fileStart + f.totalSamples;
        if (readStart >= fileStart && readStart < fileEnd) {
          const localStart = readStart - fileStart;
          const localCount = Math.min(readCount, f.totalSamples - localStart);
          const raw = await WavParser.readSamples(f, localStart, localCount);
          const decoded = WavParser.decodeSamples(raw, f, channel);
          result.set(decoded, i * samplesPerWindow);
          break;
        }
      }
    }

    return result;
  }

  async _renderSplitView(gen) {
    // Parse channel pair e.g. "0|1"
    const parts = this.channel.split('|').map(s => parseInt(s.trim()));
    const w = this.canvas.width - MARGIN_LEFT;
    const totalH = this.canvas.height - MARGIN_BOTTOM;
    const halfH = Math.floor((totalH - 2) / 2);

    for (let idx = 0; idx < parts.length && idx < 2; idx++) {
      const ch = parts[idx];
      const samples = await this._readSamplesRange(this.viewStart, this.viewEnd, ch);
      if (gen !== this._renderGeneration) return;

      const viewSamples = this.viewEnd - this.viewStart;
      const targetFrames = Math.min(w * 2, 4000);
      const hopSize = Math.max(64, Math.floor(viewSamples / targetFrames));

      const workerId = this._workerIdCounter++;
      const worker = this._fftWorkers[this._nextWorker % this._fftWorkers.length];
      this._nextWorker++;

      const promise = new Promise((resolve) => {
        this._pendingFFT.set(workerId, resolve);
      });

      worker.postMessage({
        samples: samples.buffer,
        fftSize: this.fftSize,
        hopSize,
        id: workerId,
      }, [samples.buffer]);

      const fftResult = await promise;
      if (gen !== this._renderGeneration) return;

      // Render this half
      const renderId = this._workerIdCounter++;
      const renderPromise = new Promise((resolve) => {
        this._pendingRender.set(renderId, resolve);
      });

      const magCopy = new Float32Array(fftResult.magnitudes).buffer;
      this._renderWorker.postMessage({
        magnitudes: magCopy,
        numFrames: fftResult.numFrames,
        halfFFT: fftResult.halfFFT,
        width: w,
        height: halfH,
        dbMin: this.dbMin,
        dbMax: this.dbMax,
        colormap: this.colormap,
        freqMin: this.freqMin,
        freqMax: this.freqMax,
        sampleRate: this.wavInfo.sampleRate,
        logScale: this.logScale,
        id: renderId,
      }, [magCopy]);

      const renderResult = await renderPromise;
      if (gen !== this._renderGeneration) return;

      const yOffset = idx === 0 ? 0 : halfH + 2;
      this.ctx.drawImage(renderResult.bitmap, MARGIN_LEFT, yOffset, w, halfH);
      renderResult.bitmap.close();

      // Draw channel label
      this.ctx.fillStyle = '#888';
      this.ctx.font = '11px monospace';
      const labels = ['L', 'R', 'C', 'LFE', 'LS', 'RS'];
      this.ctx.fillText(labels[ch] || `Ch${ch + 1}`, MARGIN_LEFT + 4, yOffset + 14);
    }

    // Draw divider
    const divY = Math.floor((totalH - 2) / 2);
    this.ctx.fillStyle = '#666';
    this.ctx.fillRect(MARGIN_LEFT, divY, w, 2);

    // Capture the split view as a bitmap so _redraw() preserves it
    this._lastBitmap = await createImageBitmap(this.canvas, MARGIN_LEFT, 0, w, totalH);

    this._drawAxes();
    this._drawOverlaysOnly();
  }

  _onFFTResult(data) {
    const resolve = this._pendingFFT.get(data.id);
    if (resolve) {
      this._pendingFFT.delete(data.id);
      resolve(data);
    }
  }

  _onRenderResult(data) {
    const resolve = this._pendingRender.get(data.id);
    if (resolve) {
      this._pendingRender.delete(data.id);
      resolve(data);
    }
  }

  async _renderFromMagnitudes(magnitudes, numFrames, halfFFT, w, h, gen) {
    const renderId = this._workerIdCounter++;

    const promise = new Promise((resolve) => {
      this._pendingRender.set(renderId, resolve);
    });

    const magCopy = magnitudes instanceof ArrayBuffer
      ? new Float32Array(magnitudes).buffer.slice(0)
      : new Float32Array(magnitudes).buffer;

    this._renderWorker.postMessage({
      magnitudes: magCopy,
      numFrames,
      halfFFT,
      width: w,
      height: h,
      dbMin: this.dbMin,
      dbMax: this.dbMax,
      colormap: this.colormap,
      freqMin: this.freqMin,
      freqMax: this.freqMax,
      sampleRate: this.wavInfo.sampleRate,
      logScale: this.logScale,
      id: renderId,
    }, [magCopy]);

    const result = await promise;
    if (gen !== this._renderGeneration) return;

    this._lastBitmap = result.bitmap;
    this._redraw();
  }

  _drawStretched() {
    this._redraw();
  }

  _drawAxes() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const plotW = w - MARGIN_LEFT;
    const plotH = h - MARGIN_BOTTOM;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, plotH, w, MARGIN_BOTTOM);
    ctx.fillRect(0, 0, MARGIN_LEFT, h);

    ctx.strokeStyle = '#555555';
    ctx.lineWidth = 1;

    // Time axis
    const viewDuration = (this.viewEnd - this.viewStart) / this.wavInfo.sampleRate;
    const timeStart = this.viewStart / this.wavInfo.sampleRate;

    ctx.fillStyle = '#999999';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';

    const numTimeTicks = Math.max(2, Math.floor(plotW / 100));
    for (let i = 0; i <= numTimeTicks; i++) {
      const t = timeStart + (i / numTimeTicks) * viewDuration;
      const x = MARGIN_LEFT + (i / numTimeTicks) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, plotH);
      ctx.lineTo(x, plotH + 5);
      ctx.stroke();
      ctx.fillText(this._formatTime(t), x, plotH + 20);
    }

    // Frequency axis
    ctx.textAlign = 'right';
    const numFreqTicks = Math.max(2, Math.floor(plotH / 60));
    for (let i = 0; i <= numFreqTicks; i++) {
      const frac = i / numFreqTicks;
      let freq;
      if (this.logScale && this.freqMin > 0) {
        const logMin = Math.log10(this.freqMin);
        const logMax = Math.log10(this.freqMax);
        freq = Math.pow(10, logMin + frac * (logMax - logMin));
      } else {
        freq = this.freqMin + frac * (this.freqMax - this.freqMin);
      }
      const y = plotH - frac * plotH;
      ctx.beginPath();
      ctx.moveTo(MARGIN_LEFT - 5, y);
      ctx.lineTo(MARGIN_LEFT, y);
      ctx.stroke();

      let label;
      if (freq >= 1000) {
        label = (freq / 1000).toFixed(freq >= 10000 ? 0 : 1) + 'k';
      } else {
        label = Math.round(freq).toString();
      }
      ctx.fillText(label, MARGIN_LEFT - 8, y + 4);
    }
  }

  /**
   * Redraw the spectrogram bitmap, axes, and overlays (selection, annotations).
   * The playback cursor is a separate DOM element — not drawn on canvas.
   */
  _redraw() {
    if (!this._lastBitmap) return;
    const w = this.canvas.width - MARGIN_LEFT;
    const h = this.canvas.height - MARGIN_BOTTOM;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this._lastBitmap, MARGIN_LEFT, 0, w, h);
    this._drawAxes();
    this._drawOverlaysOnly();
  }

  _drawOverlays() {
    this._redraw();
  }

  _drawOverlaysOnly() {
    const ctx = this.ctx;
    const plotW = this.canvas.width - MARGIN_LEFT;
    const plotH = this.canvas.height - MARGIN_BOTTOM;

    // Selection overlay
    if (this.selectionStart !== null && this.selectionEnd !== null) {
      const x1 = this._timeToX(this.selectionStart);
      const x2 = this._timeToX(this.selectionEnd);
      ctx.fillStyle = 'rgba(241, 86, 86, 0.15)';
      ctx.fillRect(Math.max(MARGIN_LEFT, x1), 0, x2 - x1, plotH);
      ctx.strokeStyle = 'rgba(241, 86, 86, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.max(MARGIN_LEFT, x1), 0, x2 - x1, plotH);
    }

    // Annotations
    if (this._annotations) {
      for (const ann of this._annotations) {
        const x1 = this._timeToX(ann.sessionStart);
        const x2 = this._timeToX(ann.sessionEnd);
        if (x2 < MARGIN_LEFT || x1 > this.canvas.width) continue;
        ctx.fillStyle = 'rgba(255, 200, 50, 0.15)';
        ctx.fillRect(Math.max(MARGIN_LEFT, x1), 0, x2 - x1, plotH);
        ctx.fillStyle = '#ffcc33';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(ann.note, Math.max(MARGIN_LEFT + 2, x1 + 2), 14);
      }
    }

    // Playback cursor is handled by DOM element (_updateCursorElement)
  }

  setAnnotations(annotations) {
    this._annotations = annotations;
    this._drawOverlays();
  }

  _autoFollowPending = false;

  updatePlaybackCursor(timeSec) {
    this._lastPlaybackTime = timeSec;

    // Auto-follow: if cursor reaches 90% of view width, scroll forward
    if (timeSec !== null && this.wavInfo && !this._autoFollowPending) {
      const cursorSample = timeSec * this.wavInfo.sampleRate;
      const viewDuration = this.viewEnd - this.viewStart;
      const threshold = this.viewStart + viewDuration * 0.9;
      if (cursorSample > threshold && cursorSample < this.totalSamples) {
        let newStart = Math.floor(cursorSample - viewDuration * 0.1);
        let newEnd = newStart + viewDuration;
        if (newEnd > this.totalSamples) {
          newEnd = this.totalSamples;
          newStart = Math.max(0, newEnd - viewDuration);
        }
        newStart = Math.max(0, newStart);

        // Only re-render if the view actually changes
        if (Math.abs(newStart - this.viewStart) > viewDuration * 0.005) {
          this.viewStart = newStart;
          this.viewEnd = newEnd;
          this._autoFollowPending = true;
          this.render(timeSec).then(() => {
            this._autoFollowPending = false;
          });
        }
      }
    }

    // Move the DOM cursor element via CSS transform (no canvas draw, no layout)
    this._updateCursorElement(timeSec);
  }

  _ensureCursorEl() {
    if (!this._cursorEl) {
      this._cursorEl = document.getElementById('cursor-line');
      if (!this._cursorEl) {
        this._cursorEl = document.createElement('div');
        this._cursorEl.id = 'cursor-line';
        this._cursorEl.style.cssText = 'position:absolute;top:0;left:0;width:2px;background:#f15656;pointer-events:none;z-index:2;opacity:0;';
        this.canvas.parentElement.appendChild(this._cursorEl);
      }
    }
  }

  showCursor() {
    this._ensureCursorEl();
    this._cursorEl.style.height = (this.canvas.height - MARGIN_BOTTOM) + 'px';
    this._cursorEl.style.opacity = '1';
  }

  hideCursor() {
    if (this._cursorEl) this._cursorEl.style.opacity = '0';
  }

  _cursorHeight = 0;

  _updateCursorElement(timeSec) {
    this._ensureCursorEl();
    if (!this._cursorEl || !this.wavInfo) return;

    if (timeSec === null) {
      this._cursorEl.style.opacity = '0';
      return;
    }

    const sample = Math.floor(timeSec * this.wavInfo.sampleRate);
    const x = this._timeToX(sample);

    if (x >= MARGIN_LEFT && x <= this.canvas.width) {
      this._cursorEl.style.opacity = '1';
      // Only set height when it changes (avoids triggering layout every frame)
      const h = this.canvas.height - MARGIN_BOTTOM;
      if (h !== this._cursorHeight) {
        this._cursorEl.style.height = h + 'px';
        this._cursorHeight = h;
      }
      this._cursorEl.style.transform = `translateX(${x}px)`;
    } else {
      this._cursorEl.style.opacity = '0';
    }
  }


  clearSelection() {
    this.selectionStart = null;
    this.selectionEnd = null;
    if (this.onSelectionChange) this.onSelectionChange(null, null);
    if (this._lastBitmap) {
      this._drawStretched();
    }
  }

  _formatTime(seconds) {
    const cs = Math.round(seconds * 100);
    const totalSec = Math.floor(cs / 100);
    const centis = cs % 100;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h > 0) {
      return `${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
    }
    return `${mm}:${String(s).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

  /**
   * Scroll view to center on a given time in seconds.
   */
  scrollToTime(timeSec) {
    const sample = Math.floor(timeSec * this.wavInfo.sampleRate);
    const viewDuration = this.viewEnd - this.viewStart;
    let newStart = sample - viewDuration / 2;
    let newEnd = newStart + viewDuration;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
    this.viewStart = Math.max(0, Math.floor(newStart));
    this.viewEnd = Math.floor(newEnd);
    this.render();
  }

  destroy() {
    this._resizeObserver.disconnect();
    for (const w of this._fftWorkers) w.terminate();
    if (this._renderWorker) this._renderWorker.terminate();
  }
}
