/**
 * Spectrogram renderer — manages canvas, FFT workers, tile cache, interaction.
 */

import { WavParser } from './wav-parser.js?v=3';
import { getHann, fft, magnitudesDB } from './fft-core.js';
import { buildColorLUT } from './colormaps.js';

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
    this.dbMin = -90;
    this.dbMax = 0;
    this.colormap = 'viridis';
    this.freqMin = 0;
    this.freqMax = 0;      // set from sampleRate
    this.logScale = false;
    this.channel = 'mix';

    // Selection
    this.selectionStart = null;
    this.selectionEnd = null;

    // Trim bounds (null = no trim)
    this.trimStart = null;
    this.trimEnd = null;

    // Crosshair cursor position (null = not hovering)
    this._cursorX = null;
    this._cursorY = null;

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
      const w = new Worker('js/fft-worker.js', { type: 'module' });
      w.onmessage = (e) => this._onFFTResult(e.data);
      this._fftWorkers.push(w);
    }
    this._nextWorker = 0;

    this._renderWorker = new Worker('js/render-worker.js', { type: 'module' });
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
      // Update cursor info + crosshair position
      this._cursorX = e.offsetX;
      this._cursorY = e.offsetY;
      if (this.wavInfo && this.onCursorMove) {
        const time = this._xToTime(e.offsetX);
        const freq = this._yToFreq(e.offsetY);
        if (time !== null && freq !== null) {
          this.onCursorMove(time, freq);
        }
      }
      if (!this._isDragging && this._lastBitmap) {
        this._drawStretched();
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
      // Validate minimum selection duration (0.1s)
      if (this._isDragging && this._dragButton === 0 && this._dragMoved &&
          this.selectionStart !== null && this.wavInfo) {
        const dur = Math.abs(this.selectionEnd - this.selectionStart) / this.wavInfo.sampleRate;
        if (dur < 0.1) {
          this.selectionStart = null;
          this.selectionEnd = null;
          if (this.onSelectionChange) this.onSelectionChange(null, null);
          this._drawOverlays();
        }
      }
      this._isDragging = false;
      this._dragButton = -1;
    });

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('mouseleave', () => {
      this._cursorX = null;
      this._cursorY = null;
      if (this._lastBitmap) this._drawStretched();
    });

    // --- Touch gestures ---
    // 1-finger: tap=seek, drag=selection
    // 2-finger: drag=pan, pinch=zoom
    this._touchMode = 'none';
    this._touchStartX = 0;
    this._touchMoved = false;
    this._touchStartDist = 0;
    this._touchMidX = 0;
    this._touchViewStart = 0;
    this._touchViewEnd = 0;

    c.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        this._touchMode = 'select';
        const rect = c.getBoundingClientRect();
        this._touchStartX = e.touches[0].clientX - rect.left;
        this._touchMoved = false;
      } else if (e.touches.length === 2) {
        this._touchMode = 'pan';
        const rect = c.getBoundingClientRect();
        const x0 = e.touches[0].clientX - rect.left;
        const x1 = e.touches[1].clientX - rect.left;
        const y0 = e.touches[0].clientY - rect.top;
        const y1 = e.touches[1].clientY - rect.top;
        this._touchStartDist = Math.hypot(x1 - x0, y1 - y0);
        this._touchMidX = (x0 + x1) / 2;
        this._touchViewStart = this.viewStart;
        this._touchViewEnd = this.viewEnd;
      }
    }, { passive: false });

    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!this.wavInfo) return;

      if (e.touches.length === 1 && this._touchMode === 'select') {
        const rect = c.getBoundingClientRect();
        const x = e.touches[0].clientX - rect.left;
        const dx = Math.abs(x - this._touchStartX);
        if (dx > 5) this._touchMoved = true;
        if (this._touchMoved) {
          const t1 = this._xToTime(this._touchStartX);
          const t2 = this._xToTime(x);
          if (t1 !== null && t2 !== null) {
            this.selectionStart = Math.min(t1, t2);
            this.selectionEnd = Math.max(t1, t2);
            this._drawOverlays();
            if (this.onSelectionChange) {
              this.onSelectionChange(this.selectionStart, this.selectionEnd);
            }
          }
        }
      } else if (e.touches.length === 2 && (this._touchMode === 'pan' || this._touchMode === 'select')) {
        this._touchMode = 'pan';
        const rect = c.getBoundingClientRect();
        const x0 = e.touches[0].clientX - rect.left;
        const x1 = e.touches[1].clientX - rect.left;
        const y0 = e.touches[0].clientY - rect.top;
        const y1 = e.touches[1].clientY - rect.top;
        const newDist = Math.hypot(x1 - x0, y1 - y0);
        const newMidX = (x0 + x1) / 2;

        // Pinch zoom
        const viewDuration = this._touchViewEnd - this._touchViewStart;
        const pinchRatio = this._touchStartDist / Math.max(1, newDist);
        const newDuration = Math.min(this.totalSamples, Math.max(128, viewDuration * pinchRatio));

        // Center of pinch in sample space
        const w = this.canvas.width - MARGIN_LEFT;
        const midFrac = (this._touchMidX - MARGIN_LEFT) / w;
        const centerSample = this._touchViewStart + midFrac * viewDuration;

        // Pan offset
        const panDx = newMidX - this._touchMidX;
        const panSamples = -(panDx / w) * newDuration;

        let newStart = centerSample - midFrac * newDuration + panSamples;
        let newEnd = newStart + newDuration;
        if (newStart < 0) { newEnd -= newStart; newStart = 0; }
        if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
        newStart = Math.max(0, newStart);

        this.viewStart = Math.floor(newStart);
        this.viewEnd = Math.floor(newEnd);
        this._drawStretched();
        if (this._wheelTimer) clearTimeout(this._wheelTimer);
        this._wheelTimer = setTimeout(() => this.render(), 150);
      }
    }, { passive: false });

    c.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (this._touchMode === 'select' && !this._touchMoved) {
          // Tap = seek
          const time = this._xToTime(this._touchStartX);
          if (time !== null && this.onSeek) {
            this.onSeek(time / this.wavInfo.sampleRate);
          }
        }
        // Validate minimum selection (0.1s)
        if (this._touchMode === 'select' && this._touchMoved && this.selectionStart !== null) {
          const dur = Math.abs(this.selectionEnd - this.selectionStart) / this.wavInfo.sampleRate;
          if (dur < 0.1) {
            this.selectionStart = null;
            this.selectionEnd = null;
            if (this.onSelectionChange) this.onSelectionChange(null, null);
            this._drawOverlays();
          }
        }
        this._touchMode = 'none';
      }
    }, { passive: false });

    c.addEventListener('touchcancel', () => {
      this._touchMode = 'none';
    });

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

    // Pinch-to-zoom (ctrlKey+wheel on trackpad, or Ctrl+scroll wheel)
    if (e.ctrlKey) {
      const zoomFactor = 1 + e.deltaY * 0.02;
      const viewDuration = this.viewEnd - this.viewStart;
      const newDuration = Math.min(this.totalSamples, Math.max(128, viewDuration * zoomFactor));

      // Center zoom on playback cursor if playing, else mouse position
      let centerSample;
      if (this._lastPlaybackTime !== null) {
        centerSample = Math.floor(this._lastPlaybackTime * this.wavInfo.sampleRate);
      } else {
        const mx = this._xToTime(e.offsetX);
        centerSample = mx !== null ? mx : Math.floor((this.viewStart + this.viewEnd) / 2);
      }

      // Always center on the target position
      let newStart = centerSample - newDuration / 2;
      let newEnd = newStart + newDuration;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
      newStart = Math.max(0, newStart);

      this.viewStart = Math.floor(newStart);
      this.viewEnd = Math.floor(newEnd);

      if (this._wheelTimer) clearTimeout(this._wheelTimer);
      this._drawStretched();
      this._wheelTimer = setTimeout(() => this.render(), 150);
      return;
    }

    // Two-finger horizontal scroll on trackpad → pan in time
    const dx = e.deltaX || 0;
    if (dx === 0 && e.deltaY !== 0) return; // pure vertical scroll — ignore

    const viewDuration = this.viewEnd - this.viewStart;
    const w = this.canvas.width - MARGIN_LEFT;
    const panSamples = (dx / w) * viewDuration * 2;
    let newStart = this.viewStart + panSamples;
    let newEnd = newStart + viewDuration;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
    newStart = Math.max(0, newStart);

    this.viewStart = Math.floor(newStart);
    this.viewEnd = Math.floor(newEnd);

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
    if (this.trimStart !== null && this.trimEnd !== null) {
      this.viewStart = this.trimStart;
      this.viewEnd = this.trimEnd;
    } else {
      this.viewStart = 0;
      this.viewEnd = this.totalSamples;
    }
    this.render();
  }

  setView(start, end) {
    this.viewStart = Math.max(0, start);
    this.viewEnd = Math.min(this.totalSamples, end);
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

      // In live mode, show negative seconds (right edge = "now")
      if (this._liveIsLive) {
        const secsFromNow = t - this.totalDuration;
        const label = secsFromNow >= -0.05 ? '0s' : secsFromNow.toFixed(1) + 's';
        ctx.fillText(label, x, plotH + 20);
      } else {
        ctx.fillText(this._formatTime(t), x, plotH + 20);
      }
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
    this._drawOverview();
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
      // Dashed edge lines
      ctx.strokeStyle = 'rgba(241, 86, 86, 0.6)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.max(MARGIN_LEFT, x1), 0);
      ctx.lineTo(Math.max(MARGIN_LEFT, x1), plotH);
      ctx.moveTo(x2, 0);
      ctx.lineTo(x2, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
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

    // Crosshair cursor
    if (this._cursorX !== null && this._cursorY !== null &&
        this._cursorX >= MARGIN_LEFT && this._cursorX <= this.canvas.width &&
        this._cursorY >= 0 && this._cursorY <= plotH) {
      const isDarkColormap = this.colormap !== 'grayscale';
      const lineColor = isDarkColormap ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
      const labelBg = isDarkColormap ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)';
      const labelColor = isDarkColormap ? '#ccc' : '#333';

      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;

      // Vertical line (time)
      ctx.beginPath();
      ctx.moveTo(this._cursorX, 0);
      ctx.lineTo(this._cursorX, plotH);
      ctx.stroke();

      // Horizontal line (frequency)
      ctx.beginPath();
      ctx.moveTo(MARGIN_LEFT, this._cursorY);
      ctx.lineTo(this.canvas.width, this._cursorY);
      ctx.stroke();

      ctx.setLineDash([]);

      // Labels
      ctx.font = '10px monospace';
      const timeSample = this._xToTime(this._cursorX);
      const freq = this._yToFreq(this._cursorY);

      // Time label at bottom of vertical line
      if (timeSample !== null && this.wavInfo) {
        const timeSec = timeSample / this.wavInfo.sampleRate;
        const timeStr = this._formatTime(timeSec);
        const tw = ctx.measureText(timeStr).width + 6;
        const tx = Math.min(this._cursorX - tw / 2, this.canvas.width - tw);
        ctx.fillStyle = labelBg;
        ctx.fillRect(Math.max(MARGIN_LEFT, tx), plotH + 1, tw, 14);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'center';
        ctx.fillText(timeStr, Math.max(MARGIN_LEFT + tw / 2, this._cursorX), plotH + 12);
      }

      // Frequency label at left edge of horizontal line
      if (freq !== null) {
        const freqStr = freq >= 1000 ? (freq / 1000).toFixed(1) + ' kHz' : Math.round(freq) + ' Hz';
        const fw = ctx.measureText(freqStr).width + 6;
        ctx.fillStyle = labelBg;
        ctx.fillRect(0, this._cursorY - 7, MARGIN_LEFT - 2, 14);
        ctx.fillStyle = labelColor;
        ctx.textAlign = 'right';
        ctx.fillText(freqStr, MARGIN_LEFT - 4, this._cursorY + 4);
      }

      ctx.restore();
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

  // --- Waveform overview / minimap ---

  setOverviewCanvas(canvas) {
    this._overviewCanvas = canvas;
    this._overviewCtx = canvas.getContext('2d');
    this._overviewData = null;
    this._overviewDragging = false;

    // Interaction: click/drag to navigate
    canvas.addEventListener('mousedown', (e) => {
      this._overviewDragging = true;
      this._overviewNavigate(e.offsetX);
    });
    canvas.addEventListener('mousemove', (e) => {
      if (this._overviewDragging) this._overviewNavigate(e.offsetX);
    });
    canvas.addEventListener('mouseup', () => { this._overviewDragging = false; });
    canvas.addEventListener('mouseleave', () => { this._overviewDragging = false; });

    // Touch support on overview
    canvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this._overviewDragging = true;
      const rect = canvas.getBoundingClientRect();
      this._overviewNavigate(e.touches[0].clientX - rect.left);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (this._overviewDragging) {
        const rect = canvas.getBoundingClientRect();
        this._overviewNavigate(e.touches[0].clientX - rect.left);
      }
    }, { passive: false });
    canvas.addEventListener('touchend', () => { this._overviewDragging = false; });

    // Resize handling
    new ResizeObserver(() => {
      canvas.width = Math.floor(canvas.clientWidth);
      canvas.height = 30;
      if (this._overviewData) this._drawOverview();
    }).observe(canvas);
  }

  _overviewNavigate(x) {
    if (!this._overviewCanvas || !this.wavInfo) return;
    const frac = x / this._overviewCanvas.width;
    const centerSample = Math.floor(frac * this.totalSamples);
    const viewDuration = this.viewEnd - this.viewStart;
    let newStart = centerSample - viewDuration / 2;
    let newEnd = newStart + viewDuration;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalSamples) { newStart -= (newEnd - this.totalSamples); newEnd = this.totalSamples; }
    this.viewStart = Math.max(0, Math.floor(newStart));
    this.viewEnd = Math.floor(newEnd);
    this.render();
  }

  async computeOverview() {
    if (!this.wavInfo || !this._overviewCanvas) return;
    const w = this._overviewCanvas.width || this._overviewCanvas.clientWidth;
    if (w <= 0) return;

    const blocksPerPixel = Math.max(1, Math.floor(this.totalSamples / w));
    const data = new Float32Array(w);

    // Read in chunks for efficiency
    const chunkPixels = 200;
    const chunkSamples = chunkPixels * blocksPerPixel;

    for (let px = 0; px < w; px += chunkPixels) {
      const startSample = px * blocksPerPixel;
      const count = Math.min(chunkSamples, this.totalSamples - startSample);
      if (count <= 0) break;

      try {
        const samples = await this._readSamplesRange(startSample, startSample + count, 'mix');
        // Compute peak per pixel
        for (let p = 0; p < chunkPixels && (px + p) < w; p++) {
          const from = p * blocksPerPixel;
          const to = Math.min(from + blocksPerPixel, samples.length);
          let peak = 0;
          for (let i = from; i < to; i++) {
            const abs = Math.abs(samples[i]);
            if (abs > peak) peak = abs;
          }
          data[px + p] = peak;
        }
      } catch (e) {
        // Skip on error
      }
    }

    this._overviewData = data;
    this._overviewCanvas.classList.add('visible');
    this._overviewCanvas.width = Math.floor(this._overviewCanvas.clientWidth);
    this._overviewCanvas.height = 30;
    this._drawOverview();
  }

  _drawOverview() {
    if (!this._overviewCtx || !this._overviewData) return;
    const ctx = this._overviewCtx;
    const w = this._overviewCanvas.width;
    const h = this._overviewCanvas.height;
    const data = this._overviewData;

    // Clear
    const isDark = document.body.classList.contains('dark');
    ctx.fillStyle = isDark ? '#111' : '#d8d8d8';
    ctx.fillRect(0, 0, w, h);

    // Draw waveform (mirrored)
    ctx.fillStyle = isDark ? '#555' : '#888';
    const mid = h / 2;
    const scale = w / data.length;
    for (let i = 0; i < data.length; i++) {
      const amp = Math.min(1, data[i]) * mid;
      if (amp < 0.5) continue;
      const x = Math.floor(i * scale);
      ctx.fillRect(x, mid - amp, Math.max(1, Math.ceil(scale)), amp * 2);
    }

    // Viewport indicator
    if (this.totalSamples > 0) {
      const vx1 = (this.viewStart / this.totalSamples) * w;
      const vx2 = (this.viewEnd / this.totalSamples) * w;
      ctx.fillStyle = isDark ? 'rgba(90,159,212,0.25)' : 'rgba(58,122,191,0.2)';
      ctx.fillRect(vx1, 0, vx2 - vx1, h);
      ctx.strokeStyle = isDark ? 'rgba(90,159,212,0.6)' : 'rgba(58,122,191,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx1, 0, vx2 - vx1, h);

      // Dim areas outside trim bounds
      if (this.trimStart !== null && this.trimEnd !== null) {
        const tx1 = (this.trimStart / this.totalSamples) * w;
        const tx2 = (this.trimEnd / this.totalSamples) * w;
        ctx.fillStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
        ctx.fillRect(0, 0, tx1, h);
        ctx.fillRect(tx2, 0, w - tx2, h);
      }

      // Playback cursor on overview
      if (this._lastPlaybackTime !== null && this.wavInfo) {
        const cx = (this._lastPlaybackTime * this.wavInfo.sampleRate / this.totalSamples) * w;
        ctx.strokeStyle = '#f15656';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
      }
    }
  }

  // --- Live input mode ---

  _liveCapture = null;
  _liveRAF = null;
  _liveScrolling = true;
  _liveViewSeconds = 10;
  _liveIsLive = false;
  _liveColorLUT = null;
  _liveHann = null;
  _liveYBins = null;
  _liveYBinsKey = '';
  _liveColCache = null;   // circular buffer of FFT magnitude arrays (one per column)
  _liveLastCol = 0;       // last computed column index
  _liveSamplesPerCol = 0;

  /**
   * Enter live input mode with column-cached rendering.
   * FFT results are cached per column and only new columns are computed.
   * The entire visible frame is re-rendered from cache each tick (fast — just pixel writes).
   * Data grows from the right ("now") leftward until the window fills.
   */
  setLiveSource(liveCapture) {
    this.stopLive();
    this._liveCapture = liveCapture;

    this.wavInfo = {
      sampleRate: liveCapture.sampleRate,
      channels: 1,
      bitsPerSample: 32,
      blockAlign: 4,
      totalSamples: 0,
      file: null,
      dataOffset: 0,
    };
    this.files = [];
    this.totalSamples = 0;
    this.totalDuration = 0;
    this.freqMax = liveCapture.sampleRate / 2;
    this.viewStart = 0;
    this.viewEnd = 0;
    this.selectionStart = null;
    this.selectionEnd = null;
    this._lastPlaybackTime = null;
    this._tileCache.clear();
    this._liveScrolling = true;
    this._liveIsLive = true;
    this._liveLastCol = 0;
    this._liveColCache = null;

    // Pre-build color LUT and Hann window for main-thread rendering
    this._liveColorLUT = buildColorLUT(this.colormap);
    this._liveHann = getHann(this.fftSize);

    this._liveRenderLoop();
  }

  _liveRenderLoop() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;

    try {
      const sr = this._liveCapture.sampleRate;
      const total = this._liveCapture.totalSamples;
      this.totalSamples = total;
      this.totalDuration = total / sr;

      const viewSec = this._liveViewSeconds;
      const viewSamples = Math.floor(viewSec * sr);

      // viewEnd/viewStart are in samples for axis drawing
      if (this._liveScrolling) {
        this.viewEnd = total;
        this.viewStart = Math.max(0, total - viewSamples);
      }

      const w = this.canvas.width - MARGIN_LEFT;
      const h = this.canvas.height - MARGIN_BOTTOM;

      if (w > 0 && h > 0 && total > this.fftSize) {
        // Fixed scale: one column = viewSamples/w samples
        const samplesPerCol = viewSamples / w;
        this._liveSamplesPerCol = samplesPerCol;

        // How many columns of data exist so far?
        const totalCols = Math.floor(total / samplesPerCol);

        // Allocate column cache (circular, size = canvas width)
        if (!this._liveColCache || this._liveColCache.length !== w) {
          this._liveColCache = new Array(w).fill(null);
          this._liveLastCol = 0;
        }

        // Compute FFT for new columns only
        const N = this.fftSize;
        const hann = this._liveHann;
        const windowed = new Float32Array(N);

        const newStart = Math.max(this._liveLastCol, Math.max(0, totalCols - w));
        for (let col = newStart; col < totalCols; col++) {
          const centerSample = Math.floor((col + 0.5) * samplesPerCol);
          const fftStart = centerSample - Math.floor(N / 2);

          for (let i = 0; i < N; i++) {
            const sampleIdx = fftStart + i;
            if (sampleIdx >= 0 && sampleIdx < total) {
              windowed[i] = this._liveCapture.readSample(sampleIdx) * hann[i];
            } else {
              windowed[i] = 0;
            }
          }

          const spectrum = fft(windowed, N);
          this._liveColCache[col % w] = magnitudesDB(spectrum, N);
        }
        this._liveLastCol = totalCols;

        // Render full frame from cache
        this._renderLiveFrame(w, h, totalCols, sr);
        this._redraw();
      }
    } catch (e) {
      console.error('Live render error:', e);
    }

    if (this._liveCapture && this._liveCapture.isCapturing) {
      this._liveRAF = requestAnimationFrame(() => this._liveRenderLoop());
    }
  }

  /**
   * Render the full visible frame from cached FFT columns.
   * Data is right-aligned: rightmost pixel = newest column ("now").
   * Before the window is full, left side shows silence.
   */
  _renderLiveFrame(w, h, totalCols, sr) {
    const N = this.fftSize;
    const halfFFT = N / 2;
    const lut = this._liveColorLUT;
    const dbMin = this.dbMin;
    const dbRange = this.dbMax - dbMin;
    const nyquist = sr / 2;

    // Build or reuse Y→bin mapping
    const yKey = `${h}_${this.freqMin}_${this.freqMax}_${sr}_${this.logScale}_${N}`;
    if (this._liveYBinsKey !== yKey) {
      const yBins = new Float64Array(h);
      for (let y = 0; y < h; y++) {
        const frac = 1 - y / h;
        let freq;
        if (this.logScale && this.freqMin > 0) {
          const logMin = Math.log10(this.freqMin);
          const logMax = Math.log10(this.freqMax);
          freq = Math.pow(10, logMin + frac * (logMax - logMin));
        } else {
          freq = this.freqMin + frac * (this.freqMax - this.freqMin);
        }
        yBins[y] = freq * halfFFT / nyquist;
      }
      this._liveYBins = yBins;
      this._liveYBinsKey = yKey;
    }
    const yBins = this._liveYBins;

    // Create canvas buffer for drawImage
    if (!this._liveCanvas || this._liveCanvas.width !== w || this._liveCanvas.height !== h) {
      this._liveCanvas = document.createElement('canvas');
      this._liveCanvas.width = w;
      this._liveCanvas.height = h;
      this._liveCanvasCtx = this._liveCanvas.getContext('2d');
    }

    const imgData = this._liveCanvasCtx.createImageData(w, h);
    const pixels = imgData.data;

    // Right-aligned: column (totalCols-1) maps to pixel (w-1)
    for (let x = 0; x < w; x++) {
      const colIdx = totalCols - w + x;
      const mag = (colIdx >= 0 && colIdx < totalCols) ? this._liveColCache[colIdx % w] : null;

      for (let y = 0; y < h; y++) {
        const pixIdx = (y * w + x) * 4;

        if (!mag) {
          // No data yet — dark background
          pixels[pixIdx] = 0;
          pixels[pixIdx + 1] = 0;
          pixels[pixIdx + 2] = 0;
          pixels[pixIdx + 3] = 255;
          continue;
        }

        const bin = yBins[y];
        const binLow = Math.floor(bin);
        const binHigh = Math.min(binLow + 1, halfFFT - 1);
        const f = bin - binLow;
        const db = (mag[binLow] || -100) + ((mag[binHigh] || -100) - (mag[binLow] || -100)) * f;
        const norm = Math.max(0, Math.min(255, Math.round(((db - dbMin) / dbRange) * 255)));
        const lutIdx = norm * 4;
        pixels[pixIdx]     = lut[lutIdx];
        pixels[pixIdx + 1] = lut[lutIdx + 1];
        pixels[pixIdx + 2] = lut[lutIdx + 2];
        pixels[pixIdx + 3] = 255;
      }
    }

    this._liveCanvasCtx.putImageData(imgData, 0, 0);
    this._lastBitmap = this._liveCanvas;
  }

  stopLive() {
    if (this._liveRAF) {
      cancelAnimationFrame(this._liveRAF);
      this._liveRAF = null;
    }
    this._liveCapture = null;
    this._liveColCache = null;
    this._liveCanvas = null;
    this._liveCanvasCtx = null;
    this._liveIsLive = false;
  }

  get isLive() {
    return this._liveCapture !== null && this._liveCapture.isCapturing;
  }

  destroy() {
    this.stopLive();
    this._resizeObserver.disconnect();
    for (const w of this._fftWorkers) w.terminate();
    if (this._renderWorker) this._renderWorker.terminate();
  }
}
