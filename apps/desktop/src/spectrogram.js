/**
 * On-demand spectrogram renderer.
 *
 * Reads PCM chunks from session files and computes FFT only for the
 * visible time range. Uses Web Worker pool for parallel FFT on multi-core CPUs.
 * Computed tiles are cached for fast scrolling.
 */

// Detect available CPU cores for worker pool sizing
const NUM_WORKERS = Math.min(navigator.hardwareConcurrency || 4, 8);

export class SpectrogramRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this._refreshThemeColors();

    // FFT settings
    this.fftSize = options.fftSize || 2048;
    this.windowType = options.windowType || 'hann';
    this.hopSize = options.hopSize || null; // auto-calculated
    this.minFreq = options.minFreq || 0;
    this.maxFreq = options.maxFreq || 22050;
    this.logFrequency = options.logFrequency || false; // Log frequency scale

    // Gain/contrast controls
    this.gainDB = options.gainDB || 0;          // Boost in dB (positive = amplify faint sounds)
    this.inputGainDB = 0;                        // Audio input gain (dB) for live mode
    this.dynamicRangeDB = options.dynamicRangeDB || 90;

    // Color preset
    this.colorPreset = options.colorPreset || 'viridis';

    // Channel selection: -1 = mono mix, 0..N-1 = specific channel
    this.channel = -1;
    // Split view: null = single, [chA, chB] = two channels stacked
    this.splitChannels = null;

    // View state
    this.viewStart = 0;
    this.viewEnd = 10;
    this.totalDuration = 0;

    // Trim bounds: when set, navigation is locked to this range
    this.trimStart = null;
    this.trimEnd = null;

    // Session reference (set by app)
    this.session = null;

    // Tile cache: key = "startSample-endSample-fftSize" -> { frames, freqBins, numFrames, hopSize }
    this.tileCache = new Map();
    this.maxCacheSize = 200;

    // Last computed FFT data (kept for instant gain/range re-rendering)
    this._lastFFTData = null;
    this._lastFFTDataSplit = null; // [dataA, dataB] for split view

    // Currently computing
    this._computing = false;
    this._pendingCompute = false;

    // Interaction
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartViewStart = 0;

    this.onTimeClick = null;
    this.onViewChange = null;
    this.onCursorMove = null; // Callback: (time, freq) => void
    this.onSelectionChange = null; // Callback: (startTime, endTime) => void

    // Selection state
    this.selectionStart = null; // Time in seconds (unified timeline)
    this.selectionEnd = null;
    this._isSelecting = false;

    // Annotation markers (set by app): [{sessionStart, sessionEnd, note}]
    this.annotations = [];

    // Hann window (pre-computed for file-based rendering)
    this._window = null;
    // Blackman-Harris window (pre-computed for live capture — better sidelobe suppression)
    this._liveWindow = null;

    // Rendered spectrogram image (ImageData or ImageBitmap)
    this._spectBitmap = null;

    // Last known playback time (so draw() can show cursor without explicit arg)
    this._lastPlaybackTime = null;

    // Crosshair hover position (null = not hovering)
    this._hoverX = null;
    this._hoverY = null;

    // Web Worker pool for parallel FFT
    this._workers = [];
    this._workerReady = [];
    this._initWorkers();

    // Render worker for off-main-thread pixel rendering
    this._renderWorker = null;
    this._initRenderWorker();

    this._setupInteraction();
    this._setupScrollbar();
  }

  _refreshThemeColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (name) => s.getPropertyValue(name).trim();
    this._theme = {
      canvasBg: v('--canvas-bg') || '#1a1a1a',
      axisText: v('--canvas-axis-text') || '#aaaaaa',
      axisGrid: v('--canvas-axis-grid') || 'rgba(170,170,170,0.2)',
      tick: v('--canvas-tick') || '#555555',
      selection: v('--canvas-selection') || 'rgba(90,159,212,0.2)',
      selectionStroke: v('--canvas-selection-stroke') || 'rgba(90,159,212,0.7)',
      wallTime: v('--canvas-wall-time') || '#5cb87a',
      dimText: v('--canvas-dim-text') || '#666666',
      labelBg: v('--canvas-label-bg') || 'rgba(0,0,0,0.5)',
      labelText: v('--canvas-label-text') || '#ccc',
      fileBoundary: v('--canvas-file-boundary') || 'rgba(255,200,80,0.3)',
      fileLabel: v('--canvas-file-label') || 'rgba(255,200,80,0.5)',
      divider: v('--canvas-divider') || '#666',
      orange: v('--orange') || '#d4863a',
    };
  }

  /**
   * Initialize with a session.
   */
  setSession(session) {
    this.session = session;
    this.totalDuration = session.totalDuration;
    this.maxFreq = Math.min(this.maxFreq, session.sampleRate / 2);
    this.viewStart = 0;
    this.viewEnd = this.totalDuration;
    this.trimStart = null;
    this.trimEnd = null;
    this.tileCache.clear();
    this._window = null;
    this._liveWindow = null;
  }

  // Progress callback: (phase, percent) => void
  // phase: 'reading' | 'computing' | 'rendering'
  onProgress = null;

  // Overview progress callback: (percent) => void  (0..100, null = done)
  onOverviewProgress = null;

  /**
   * Compute and render the spectrogram for the current view.
   */
  async computeVisible() {
    if (!this.session || this._computing) {
      this._pendingCompute = true;
      return;
    }

    this._computing = true;

    try {
      const viewDuration = this.viewEnd - this.viewStart;
      const canvasWidth = this.canvas.width - 60;

      // Target: ~2 FFT frames per pixel, capped to keep computation fast
      const targetFrames = Math.max(1, Math.min(canvasWidth * 2, 4000));

      // The hop size determines how many samples per FFT frame.
      // Allow heavy overlap for large FFT sizes to avoid pixelation —
      // hop is driven by pixel density, with a small minimum to avoid
      // degenerate cases.
      const hopSize = this.hopSize || Math.max(
        64,
        Math.floor((viewDuration * this.session.sampleRate) / targetFrames)
      );

      // Total samples we'd need to read for this view
      const startSample = Math.floor(this.viewStart * this.session.sampleRate);
      const endSample = Math.ceil(this.viewEnd * this.session.sampleRate);
      const totalViewSamples = endSample - startSample;

      // How many samples we actually need: targetFrames * hopSize + fftSize
      const samplesNeeded = targetFrames * hopSize + this.fftSize;

      // If we'd need to read way more samples than we need for the target
      // frames, we should subsample: read small windows spaced apart.
      // Also force subsampling if the total view would require too much memory
      // (more than ~16M samples = 64MB Float32Array).
      const maxFullModeSamples = 16 * 1024 * 1024;
      const needsSubsampling = totalViewSamples > samplesNeeded * 1.5 ||
                               totalViewSamples > maxFullModeSamples;

      if (this.splitChannels) {
        // Split view: compute both channels
        const [chA, chB] = this.splitChannels;
        const dataForChannels = [];

        for (const ch of [chA, chB]) {
          const chCacheKey = `${startSample}-${endSample}-${this.fftSize}-${targetFrames}-ch${ch}-${this.windowType}`;
          let chData = this.tileCache.get(chCacheKey);

          if (!chData) {
            this._reportProgress('reading', 0);
            await new Promise(r => setTimeout(r, 0));

            const savedChannel = this.channel;
            this.channel = ch;

            if (needsSubsampling) {
              chData = await this._computeSubsampled(startSample, endSample, targetFrames);
            } else {
              const pcmData = await this._readPCMRange(startSample, totalViewSamples);
              if (!pcmData) { this.channel = savedChannel; this._computing = false; this._reportProgress('done', 100); return; }
              this._reportProgress('computing', 0);
              await new Promise(r => setTimeout(r, 0));
              chData = await this._computeFFTOnWorkers(pcmData, hopSize);
            }

            this.channel = savedChannel;

            if (this.tileCache.size >= this.maxCacheSize) {
              const keys = [...this.tileCache.keys()];
              for (let i = 0; i < 50 && i < keys.length; i++) this.tileCache.delete(keys[i]);
            }
            this.tileCache.set(chCacheKey, chData);
          }
          dataForChannels.push(chData);
        }

        this._lastFFTData = null;
        this._lastFFTDataSplit = dataForChannels;
        this._reportProgress('rendering', 0);
        await this._renderSplitSpectrogram(dataForChannels[0], dataForChannels[1]);
        this._reportProgress('done', 100);
        this.draw();
      } else {
        // Single channel / mix mode
        const cacheKey = `${startSample}-${endSample}-${this.fftSize}-${targetFrames}-ch${this.channel}-${this.windowType}`;
        let spectrogramData = this.tileCache.get(cacheKey);

        if (!spectrogramData) {
          this._reportProgress('reading', 0);
          await new Promise(r => setTimeout(r, 0));

          if (needsSubsampling) {
            spectrogramData = await this._computeSubsampled(
              startSample, endSample, targetFrames
            );
          } else {
            const pcmData = await this._readPCMRange(startSample, totalViewSamples);
            if (!pcmData) {
              this._computing = false;
              this._reportProgress('done', 100);
              return;
            }
            this._reportProgress('computing', 0);
            await new Promise(r => setTimeout(r, 0));
            spectrogramData = await this._computeFFTOnWorkers(pcmData, hopSize);
          }

          if (this.tileCache.size >= this.maxCacheSize) {
            const keys = [...this.tileCache.keys()];
            for (let i = 0; i < 50 && i < keys.length; i++) {
              this.tileCache.delete(keys[i]);
            }
          }
          this.tileCache.set(cacheKey, spectrogramData);
        }

        this._lastFFTData = spectrogramData;
        this._lastFFTDataSplit = null;
        this._reportProgress('rendering', 0);
        await this._renderSpectrogram(spectrogramData);
        this._reportProgress('done', 100);
        this.draw();
      }
    } catch (err) {
      console.error('Spectrogram compute error:', err);
      this._reportProgress('error', 0);
    }

    this._computing = false;

    if (this._pendingCompute) {
      this._pendingCompute = false;
      this.computeVisible();
    }
  }

  /**
   * Subsampled spectrogram for wide views (hours of audio).
   * Instead of reading all samples, reads chunks and picks evenly-spaced
   * windows from each chunk. Much faster than one IPC call per frame.
   */
  async _computeSubsampled(startSample, endSample, targetFrames) {
    const N = this.fftSize;
    const freqBins = N / 2;
    const totalSpan = endSample - startSample;
    const step = Math.max(1, Math.floor(totalSpan / targetFrames));
    const session = this.session;
    const t0 = performance.now();
    let tRead = 0, tDecode = 0, tFFT = 0;

    this._ensureWindow(N);

    const frames = new Array(targetFrames);
    let framesComputed = 0;
    const blockAlign = session.blockAlign;
    const windowBytes = N * blockAlign;

    // Strategy: use scattered reads — one IPC call per file reads only the
    // small N-sample windows we need, skipping the huge gaps between them.
    // This transfers ~20MB instead of ~4GB for a 30-min view.

    for (const file of session.files) {
      const fileStartSample = file.sampleStart;
      const fileEndSample = file.sampleStart + file.samples;

      const firstFrame = Math.max(0, Math.ceil((fileStartSample - startSample) / step));
      const lastFrame = Math.min(targetFrames - 1,
        Math.floor((fileEndSample - startSample - N) / step));

      if (firstFrame > lastFrame || lastFrame < 0) continue;

      // Build list of frame positions relative to file start
      const framePositions = [];
      for (let i = firstFrame; i <= lastFrame; i++) {
        const samplePos = startSample + i * step;
        const offInFile = samplePos - fileStartSample;
        if (offInFile >= 0 && offInFile + N <= file.samples) {
          framePositions.push({ frameIdx: i, offsetInFile: offInFile });
        }
      }

      if (framePositions.length === 0) continue;

      // Split into IPC batches (max ~2000 windows per call to avoid huge args)
      const MAX_WINDOWS_PER_CALL = 2000;
      for (let bi = 0; bi < framePositions.length; bi += MAX_WINDOWS_PER_CALL) {
        const batch = framePositions.slice(bi, bi + MAX_WINDOWS_PER_CALL);

        this._reportProgress('reading', Math.round((framesComputed / targetFrames) * 100));

        // Build scattered read descriptors
        const windows = batch.map(fp => ({
          byteOffset: fp.offsetInFile * blockAlign,
          byteLength: windowBytes
        }));

        const tr0 = performance.now();
        const rawBytes = await window.electronAPI.readPcmScattered(
          file.filePath, file.dataOffset, windows
        );
        tRead += performance.now() - tr0;

        // Decode the concatenated windows into a packed buffer
        const numBatchFrames = batch.length;
        const allPacked = new Float32Array(numBatchFrames * N);
        const allFrameIndices = new Array(numBatchFrames);

        const td0 = performance.now();
        for (let f = 0; f < numBatchFrames; f++) {
          this._decodePCM(
            new DataView(rawBytes, f * windowBytes, windowBytes),
            session.bitsPerSample, session.channels,
            allPacked, f * N, N
          );
          allFrameIndices[f] = batch[f].frameIdx;
        }
        tDecode += performance.now() - td0;

        // Bulk FFT — slice per worker to minimize cloning
        const tf0 = performance.now();
        if (this._workers.length > 0 && numBatchFrames > 1) {
          const numWorkers = Math.min(this._workers.length, numBatchFrames);
          const framesPerWorker = Math.ceil(numBatchFrames / numWorkers);
          const promises = [];

          for (let w = 0; w < numWorkers; w++) {
            const wStart = w * framesPerWorker;
            const wEnd = Math.min(wStart + framesPerWorker, numBatchFrames);
            if (wStart >= wEnd) break;

            const workerPcm = allPacked.slice(wStart * N, wEnd * N);
            promises.push(new Promise((resolve) => {
              const worker = this._workers[w];
              worker.onmessage = (e) => resolve({ wStart, magnitudes: e.data.magnitudes });
              worker.postMessage({
                type: 'computeBulk',
                pcm: workerPcm,
                fftSize: N,
                hopSize: N,
                windowFunc: this._window,
                startFrame: 0,
                numFrames: wEnd - wStart
              });
            }));
          }

          const results = await Promise.all(promises);
          for (const { wStart, magnitudes } of results) {
            for (let k = 0; k < magnitudes.length; k++) {
              frames[allFrameIndices[wStart + k]] = magnitudes[k];
            }
          }
        } else {
          for (let f = 0; f < numBatchFrames; f++) {
            const frame = new Float32Array(N);
            for (let j = 0; j < N; j++) {
              frame[j] = allPacked[f * N + j] * this._window[j];
            }
            frames[allFrameIndices[f]] = this._fftFrame(frame);
          }
        }
        tFFT += performance.now() - tf0;
        framesComputed += numBatchFrames;
      }

      this._reportProgress('computing', Math.round((framesComputed / targetFrames) * 100));
      await new Promise(r => setTimeout(r, 0));
    }

    // Fill gaps (frames between files) with silence
    for (let i = 0; i < targetFrames; i++) {
      if (!frames[i]) {
        frames[i] = new Float32Array(freqBins);
        frames[i].fill(-120);
      }
    }

    const totalMs = performance.now() - t0;
    console.log(`[subsampled] total=${totalMs.toFixed(0)}ms read=${tRead.toFixed(0)}ms decode=${tDecode.toFixed(0)}ms fft=${tFFT.toFixed(0)}ms | ${targetFrames} frames, step=${step}, N=${N}`);
    return { frames, freqBins, numFrames: targetFrames, hopSize: step };
  }

  _reportProgress(phase, percent) {
    if (this.onProgress) {
      this.onProgress(phase, percent);
    }
  }

  // ── Web Worker Pool ─────────────────────────────────────────────────────

  _initWorkers() {
    try {
      for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker('src/fft-worker.js', { type: 'module' });
        this._workers.push(worker);
        this._workerReady.push(true);
      }
      console.log(`FFT worker pool: ${NUM_WORKERS} workers (${navigator.hardwareConcurrency} cores detected)`);
    } catch (err) {
      console.warn('Web Workers not available, using main thread FFT:', err.message);
      this._workers = [];
    }
  }

  _initRenderWorker() {
    try {
      this._renderWorker = new Worker('src/render-worker.js', { type: 'module' });
    } catch (err) {
      console.warn('Render worker not available, using main thread rendering:', err.message);
      this._renderWorker = null;
    }
  }

  /**
   * Compute FFT for a batch of windowed frames using the worker pool.
   * Used by the subsampled path which sends pre-extracted frame data.
   * Returns array of Float32Array magnitudes.
   */
  async _computeFFTBatch(windowedFrames) {
    if (this._workers.length === 0) {
      return windowedFrames.map(frame => this._fftFrame(frame));
    }

    const numWorkers = Math.min(this._workers.length, windowedFrames.length);
    const chunkSize = Math.ceil(windowedFrames.length / numWorkers);
    const promises = [];

    const N = this.fftSize;
    this._ensureWindow(N);

    for (let w = 0; w < numWorkers; w++) {
      const start = w * chunkSize;
      const end = Math.min(start + chunkSize, windowedFrames.length);
      if (start >= end) break;

      const tasks = [];
      for (let i = start; i < end; i++) {
        tasks.push({ data: windowedFrames[i], windowFunc: this._window });
      }

      const promise = new Promise((resolve) => {
        const worker = this._workers[w];
        worker.onmessage = (e) => resolve(e.data.magnitudes);
        worker.postMessage({ type: 'compute', tasks, fftSize: N });
      });
      promises.push(promise);
    }

    return (await Promise.all(promises)).flat();
  }

  /**
   * Full-mode FFT on workers: sends contiguous PCM + window to workers,
   * each worker processes a slice of frames (windowing + FFT + dB).
   * Returns { frames, freqBins, numFrames, hopSize }.
   */
  async _computeFFTOnWorkers(monoData, hopSize) {
    const N = this.fftSize;
    const numFrames = Math.max(1, Math.floor((monoData.length - N) / hopSize) + 1);
    const freqBins = N / 2;

    this._ensureWindow(N);

    if (this._workers.length === 0) {
      // Fallback: main thread
      return this._computeFFTMainThread(monoData, hopSize);
    }

    const numWorkers = Math.min(this._workers.length, numFrames);
    const framesPerWorker = Math.ceil(numFrames / numWorkers);
    const promises = [];

    for (let w = 0; w < numWorkers; w++) {
      const startFrame = w * framesPerWorker;
      const endFrame = Math.min(startFrame + framesPerWorker, numFrames);
      if (startFrame >= endFrame) break;
      const workerFrames = endFrame - startFrame;

      const promise = new Promise((resolve) => {
        const worker = this._workers[w];
        worker.onmessage = (e) => resolve({ startFrame, magnitudes: e.data.magnitudes });
        worker.postMessage({
          type: 'computeBulk',
          pcm: monoData,        // SharedArrayBuffer-like (structured clone)
          fftSize: N,
          hopSize,
          windowFunc: this._window,
          startFrame,
          numFrames: workerFrames
        });
      });
      promises.push(promise);
    }

    const results = await Promise.all(promises);
    const frames = new Array(numFrames);
    for (const { startFrame, magnitudes } of results) {
      for (let i = 0; i < magnitudes.length; i++) {
        frames[startFrame + i] = magnitudes[i];
      }
    }

    this._reportProgress('computing', 100);
    return { frames, freqBins, numFrames, hopSize };
  }

  /**
   * Main-thread FFT fallback (when no workers available).
   */
  _computeFFTMainThread(monoData, hopSize) {
    const N = this.fftSize;
    const numFrames = Math.max(1, Math.floor((monoData.length - N) / hopSize) + 1);
    const freqBins = N / 2;

    this._ensureWindow(N);
    const frames = new Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      const frame = new Float32Array(N);
      for (let j = 0; j < N; j++) {
        frame[j] = (monoData[start + j] || 0) * this._window[j];
      }
      frames[i] = this._fftFrame(frame);
    }

    return { frames, freqBins, numFrames, hopSize };
  }

  _ensureWindow(N) {
    if (!this._window || this._window.length !== N || this._windowType !== this.windowType) {
      this._window = this._buildWindow(this.windowType, N);
      this._windowType = this.windowType;
    }
  }

  _ensureLiveWindow(N) {
    if (!this._liveWindow || this._liveWindow.length !== N || this._liveWindowType !== this.windowType) {
      this._liveWindow = this._buildWindow(this.windowType, N);
      this._liveWindowType = this.windowType;
      // Compute normalization: 20*log10(sum(window)/2) so display is calibrated to dBFS
      let wSum = 0;
      for (let i = 0; i < N; i++) wSum += this._liveWindow[i];
      this._liveWindowNormDB = 20 * Math.log10(wSum / 2);
    }
  }

  _buildWindow(type, N) {
    const w = new Float32Array(N);
    const pi2 = 2 * Math.PI;
    switch (type) {
      case 'hamming':
        for (let i = 0; i < N; i++)
          w[i] = 0.54 - 0.46 * Math.cos(pi2 * i / (N - 1));
        break;
      case 'blackman-harris': {
        const a0 = 0.35875, a1 = 0.48829, a2 = 0.14128, a3 = 0.01168;
        for (let i = 0; i < N; i++) {
          const x = pi2 * i / (N - 1);
          w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x) - a3 * Math.cos(3 * x);
        }
        break;
      }
      case 'flat-top': {
        const a0 = 0.21557895, a1 = 0.41663158, a2 = 0.277263158;
        const a3 = 0.083578947, a4 = 0.006947368;
        for (let i = 0; i < N; i++) {
          const x = pi2 * i / (N - 1);
          w[i] = a0 - a1 * Math.cos(x) + a2 * Math.cos(2 * x)
               - a3 * Math.cos(3 * x) + a4 * Math.cos(4 * x);
        }
        break;
      }
      default: // hann
        for (let i = 0; i < N; i++)
          w[i] = 0.5 * (1 - Math.cos(pi2 * i / (N - 1)));
    }
    return w;
  }

  /**
   * Compute a single FFT frame on the main thread (fallback).
   */
  _fftFrame(data) {
    const N = this.fftSize;
    const freqBins = N / 2;
    const spectrum = this._fft(data);
    const magnitudes = new Float32Array(freqBins);
    for (let j = 0; j < freqBins; j++) {
      const re = spectrum[2 * j];
      const im = spectrum[2 * j + 1];
      const mag = Math.sqrt(re * re + im * im);
      const db = 20 * Math.log10(Math.max(mag, 1e-10));
      magnitudes[j] = isFinite(db) ? db : -120;
    }
    return magnitudes;
  }

  /**
   * Read PCM samples from session files for the given sample range.
   * Issues parallel IPC reads (up to PARALLEL_READS concurrent) for throughput.
   */
  async _readPCMRange(startSample, numSamples, silent = false) {
    const session = this.session;
    const blockAlign = session.blockAlign;
    const mono = new Float32Array(numSamples);
    const PARALLEL_READS = 4;

    // Build a flat list of chunk descriptors
    const chunks = [];
    let samplesPlanned = 0;

    for (const file of session.files) {
      if (samplesPlanned >= numSamples) break;

      const fileEndSample = file.sampleStart + file.samples;
      const readStart = startSample + samplesPlanned;

      if (readStart >= fileEndSample) continue;
      if (readStart + (numSamples - samplesPlanned) <= file.sampleStart) continue;

      const fileOffset = Math.max(0, readStart - file.sampleStart);
      const remainingInFile = file.samples - fileOffset;
      const toRead = Math.min(numSamples - samplesPlanned, remainingInFile);
      if (toRead <= 0) continue;

      // Split into sub-chunks (max 8MB each, aligned to blockAlign)
      const maxChunkBytes = Math.floor((8 * 1024 * 1024) / blockAlign) * blockAlign;
      let done = 0;
      while (done < toRead) {
        const chunkSamples = Math.min(Math.floor(maxChunkBytes / blockAlign), toRead - done);
        chunks.push({
          file,
          fileOffset: fileOffset + done,
          chunkSamples,
          outputOffset: samplesPlanned + done
        });
        done += chunkSamples;
      }

      samplesPlanned += toRead;
    }

    // Issue reads in parallel batches
    let completed = 0;
    for (let i = 0; i < chunks.length; i += PARALLEL_READS) {
      const batch = chunks.slice(i, i + PARALLEL_READS);
      const promises = batch.map(c => {
        const byteOff = c.fileOffset * blockAlign;
        const byteLen = c.chunkSamples * blockAlign;
        return window.electronAPI.readPcmChunk(
          c.file.filePath, c.file.dataOffset, byteOff, byteLen
        );
      });

      const results = await Promise.all(promises);

      for (let j = 0; j < batch.length; j++) {
        const rawBytes = results[j];
        const c = batch[j];
        const actualSamples = Math.floor(rawBytes.byteLength / blockAlign);
        this._decodePCM(
          new DataView(rawBytes), session.bitsPerSample, session.channels,
          mono, c.outputOffset, actualSamples
        );
      }

      completed += batch.length;
      if (!silent) this._reportProgress('reading', Math.round((completed / chunks.length) * 100));
    }

    return mono;
  }

  /**
   * Decode raw PCM bytes to float samples.
   * channel: -1 = mono downmix, 0..N-1 = specific channel.
   * Handles 16-bit, 24-bit, 32-bit integer, and 32-bit float.
   */
  _decodePCM(view, bitsPerSample, channels, output, outputOffset, numSamples) {
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const isFloat = this.session && this.session.format === 3;
    const selectedChannel = this.channel;
    const isMix = selectedChannel < 0 || selectedChannel >= channels;
    const scale = isMix ? 1 / channels : 1;

    for (let i = 0; i < numSamples; i++) {
      const frameOffset = i * blockAlign;
      if (frameOffset + blockAlign > view.byteLength) break;

      let outValue = 0;

      if (isMix) {
        // Mono downmix: average all channels
        for (let ch = 0; ch < channels; ch++) {
          outValue += this._readSample(view, frameOffset + ch * bytesPerSample, bitsPerSample, isFloat) * scale;
        }
      } else {
        // Single channel extraction
        outValue = this._readSample(view, frameOffset + selectedChannel * bytesPerSample, bitsPerSample, isFloat);
      }

      output[outputOffset + i] = outValue;
    }
  }

  _readSample(view, offset, bitsPerSample, isFloat) {
    if (bitsPerSample === 16) {
      return view.getInt16(offset, true) / 32768;
    } else if (bitsPerSample === 24) {
      const b0 = view.getUint8(offset);
      const b1 = view.getUint8(offset + 1);
      const b2 = view.getInt8(offset + 2);
      return (b2 * 65536 + b1 * 256 + b0) / 8388608;
    } else if (bitsPerSample === 32 && isFloat) {
      return view.getFloat32(offset, true);
    } else if (bitsPerSample === 32) {
      return view.getInt32(offset, true) / 2147483648;
    }
    return 0;
  }

  // _computeFFT replaced by _computeFFTOnWorkers + _computeFFTMainThread

  /**
   * Cooley-Tukey FFT (radix-2).
   */
  _fft(input) {
    const N = input.length;
    const logN = Math.log2(N);
    const output = new Float32Array(2 * N);

    for (let i = 0; i < N; i++) {
      const j = this._bitReverse(i, logN);
      output[2 * j] = input[i];
    }

    for (let s = 1; s <= logN; s++) {
      const m = 1 << s;
      const halfM = m >> 1;
      const wRe = Math.cos(-2 * Math.PI / m);
      const wIm = Math.sin(-2 * Math.PI / m);

      for (let k = 0; k < N; k += m) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < halfM; j++) {
          const idx1 = 2 * (k + j);
          const idx2 = 2 * (k + j + halfM);
          const tRe = curRe * output[idx2] - curIm * output[idx2 + 1];
          const tIm = curRe * output[idx2 + 1] + curIm * output[idx2];

          output[idx2] = output[idx1] - tRe;
          output[idx2 + 1] = output[idx1 + 1] - tIm;
          output[idx1] += tRe;
          output[idx1 + 1] += tIm;

          const newRe = curRe * wRe - curIm * wIm;
          const newIm = curRe * wIm + curIm * wRe;
          curRe = newRe;
          curIm = newIm;
        }
      }
    }

    return output;
  }

  _bitReverse(x, bits) {
    let result = 0;
    for (let i = 0; i < bits; i++) {
      result = (result << 1) | (x & 1);
      x >>= 1;
    }
    return result;
  }

  /**
   * Render spectrogram data to canvas.
   * Delegates to render worker when available; falls back to main thread.
   */
  async _renderSpectrogram(data) {
    const { width, height } = this.canvas;
    const spectWidth = width - 60;
    const spectHeight = height - 40;

    if (spectWidth <= 0 || spectHeight <= 0) return;

    const { frames, freqBins, numFrames } = data;

    if (this._renderWorker) {
      // Offload to render worker
      const bitmap = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Render worker timeout')), 15000);
        this._renderWorker.onmessage = (e) => {
          clearTimeout(timeout);
          resolve(e.data.bitmap);
        };
        this._renderWorker.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error('Render worker error: ' + e.message));
        };
        this._renderWorker.postMessage({
          type: 'render',
          frames, freqBins, numFrames,
          width: spectWidth, height: spectHeight,
          sampleRate: this.session.sampleRate,
          fftSize: this.fftSize,
          minFreq: this.minFreq,
          maxFreq: this.maxFreq,
          logFrequency: this.logFrequency,
          gainDB: this.gainDB,
          dynamicRangeDB: this.dynamicRangeDB,
          colorPreset: this.colorPreset
        });
      });

      // Store bitmap for redrawing with cursor
      this._spectBitmap = bitmap;
      this._spectImage = null;
      this._spectWidth = spectWidth;
      this._spectHeight = spectHeight;
    } else {
      // Main-thread fallback
      this._renderSpectrogramMainThread(data);
    }
  }

  /**
   * Main-thread rendering fallback.
   */
  _renderSpectrogramMainThread(data) {
    const { width, height } = this.canvas;
    const spectWidth = width - 60;
    const spectHeight = height - 40;
    if (spectWidth <= 0 || spectHeight <= 0) return;

    const { frames, freqBins, numFrames } = data;

    const binRes = this.session.sampleRate / this.fftSize;
    const minBin = Math.max(1, Math.floor(this.minFreq / binRes));
    const maxBin = Math.min(Math.ceil(this.maxFreq / binRes), freqBins - 1);
    const visibleBins = maxBin - minBin;

    const binLookupLow = new Int32Array(spectHeight);
    const binLookupFrac = new Float32Array(spectHeight);
    const logMinFreq = Math.log(Math.max(this.minFreq, 20));
    const logMaxFreq = Math.log(Math.max(this.maxFreq, 21));

    for (let y = 0; y < spectHeight; y++) {
      const ratio = (spectHeight - 1 - y) / spectHeight;
      let binF;
      if (this.logFrequency) {
        const logFreq = logMinFreq + ratio * (logMaxFreq - logMinFreq);
        binF = Math.exp(logFreq) / binRes;
      } else {
        binF = minBin + ratio * visibleBins;
      }
      binF = Math.max(minBin, Math.min(binF, maxBin));
      binLookupLow[y] = Math.floor(binF);
      binLookupFrac[y] = binF - Math.floor(binF);
    }

    const imageData = this.ctx.createImageData(spectWidth, spectHeight);
    const pixels = imageData.data;
    const floor = -this.dynamicRangeDB;

    for (let x = 0; x < spectWidth; x++) {
      const frameIdx = Math.min(Math.floor(x * numFrames / spectWidth), numFrames - 1);
      const spectrum = frames[frameIdx];

      for (let y = 0; y < spectHeight; y++) {
        const bin0 = binLookupLow[y];
        const frac = binLookupFrac[y];

        let raw0 = spectrum[bin0];
        if (raw0 === undefined || !isFinite(raw0)) raw0 = -120;
        let raw;
        if (frac > 0 && bin0 + 1 <= maxBin) {
          let raw1 = spectrum[bin0 + 1];
          if (raw1 === undefined || !isFinite(raw1)) raw1 = -120;
          raw = raw0 + frac * (raw1 - raw0);
        } else {
          raw = raw0;
        }

        const db = raw + this.gainDB;
        const normalized = Math.max(0, Math.min(1, (db - floor) / this.dynamicRangeDB));
        const [r, g, b] = this._colorize(normalized);

        const idx = (y * spectWidth + x) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    this._spectImage = imageData;
    this._spectBitmap = null;
    this._spectWidth = spectWidth;
    this._spectHeight = spectHeight;
  }

  /**
   * Render split-view spectrogram: two channels stacked with a divider.
   */
  async _renderSplitSpectrogram(dataA, dataB) {
    const { width, height } = this.canvas;
    const spectWidth = width - 60;
    const spectHeight = height - 40;
    if (spectWidth <= 0 || spectHeight <= 0) return;

    const dividerHeight = 2;
    const halfHeight = Math.floor((spectHeight - dividerHeight) / 2);

    if (this._renderWorker) {
      // Render both halves on the render worker sequentially
      const renderHalf = (data, h) => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Render worker timeout')), 15000);
        this._renderWorker.onmessage = (e) => {
          clearTimeout(timeout);
          resolve(e.data.bitmap);
        };
        this._renderWorker.onerror = (e) => {
          clearTimeout(timeout);
          reject(new Error('Render worker error: ' + e.message));
        };
        this._renderWorker.postMessage({
          type: 'render',
          frames: data.frames, freqBins: data.freqBins, numFrames: data.numFrames,
          width: spectWidth, height: h,
          sampleRate: this.session.sampleRate,
          fftSize: this.fftSize,
          minFreq: this.minFreq,
          maxFreq: this.maxFreq,
          logFrequency: this.logFrequency,
          gainDB: this.gainDB,
          dynamicRangeDB: this.dynamicRangeDB,
          colorPreset: this.colorPreset
        });
      });

      const bitmapA = await renderHalf(dataA, halfHeight);
      const bitmapB = await renderHalf(dataB, halfHeight);

      // Compose onto an offscreen canvas, then get a single bitmap
      const offscreen = new OffscreenCanvas(spectWidth, spectHeight);
      const octx = offscreen.getContext('2d');
      octx.drawImage(bitmapA, 0, 0);
      // Divider line
      octx.fillStyle = this._theme.divider;
      octx.fillRect(0, halfHeight, spectWidth, dividerHeight);
      octx.drawImage(bitmapB, 0, halfHeight + dividerHeight);

      this._spectBitmap = await createImageBitmap(offscreen);
      this._spectImage = null;
    } else {
      // Main-thread fallback: render into one ImageData
      const imageData = this.ctx.createImageData(spectWidth, spectHeight);
      const pixels = imageData.data;

      this._renderHalfIntoPixels(dataA, pixels, spectWidth, 0, halfHeight);
      // Divider
      for (let x = 0; x < spectWidth; x++) {
        for (let dy = 0; dy < dividerHeight; dy++) {
          const idx = ((halfHeight + dy) * spectWidth + x) * 4;
          pixels[idx] = 102; pixels[idx + 1] = 102; pixels[idx + 2] = 102; pixels[idx + 3] = 255;
        }
      }
      this._renderHalfIntoPixels(dataB, pixels, spectWidth, halfHeight + dividerHeight, halfHeight);

      this._spectImage = imageData;
      this._spectBitmap = null;
    }

    this._spectWidth = spectWidth;
    this._spectHeight = spectHeight;
  }

  /**
   * Render one channel's FFT data into a region of a pixel buffer.
   */
  _renderHalfIntoPixels(data, pixels, spectWidth, yOffset, halfHeight) {
    const { frames, freqBins, numFrames } = data;
    const binRes = this.session.sampleRate / this.fftSize;
    const minBin = Math.max(1, Math.floor(this.minFreq / binRes));
    const maxBin = Math.min(Math.ceil(this.maxFreq / binRes), freqBins - 1);
    const visibleBins = maxBin - minBin;

    const binLookupLow = new Int32Array(halfHeight);
    const binLookupFrac = new Float32Array(halfHeight);
    const logMinFreq = Math.log(Math.max(this.minFreq, 20));
    const logMaxFreq = Math.log(Math.max(this.maxFreq, 21));

    for (let y = 0; y < halfHeight; y++) {
      const ratio = (halfHeight - 1 - y) / halfHeight;
      let binF;
      if (this.logFrequency) {
        binF = Math.exp(logMinFreq + ratio * (logMaxFreq - logMinFreq)) / binRes;
      } else {
        binF = minBin + ratio * visibleBins;
      }
      binF = Math.max(minBin, Math.min(binF, maxBin));
      binLookupLow[y] = Math.floor(binF);
      binLookupFrac[y] = binF - Math.floor(binF);
    }

    const floor = -this.dynamicRangeDB;

    for (let x = 0; x < spectWidth; x++) {
      const frameIdx = Math.min(Math.floor(x * numFrames / spectWidth), numFrames - 1);
      const spectrum = frames[frameIdx];
      if (!spectrum) continue;

      for (let y = 0; y < halfHeight; y++) {
        const bin0 = binLookupLow[y];
        const frac = binLookupFrac[y];
        let raw0 = spectrum[bin0];
        if (raw0 === undefined || !isFinite(raw0)) raw0 = -120;
        let raw;
        if (frac > 0 && bin0 + 1 <= maxBin) {
          let raw1 = spectrum[bin0 + 1];
          if (raw1 === undefined || !isFinite(raw1)) raw1 = -120;
          raw = raw0 + frac * (raw1 - raw0);
        } else {
          raw = raw0;
        }

        const db = raw + this.gainDB;
        const normalized = Math.max(0, Math.min(1, (db - floor) / this.dynamicRangeDB));
        const [r, g, b] = this._colorize(normalized);

        const idx = ((yOffset + y) * spectWidth + x) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }
  }

  /**
   * Draw the spectrogram + axes + cursor to the visible canvas.
   */
  draw(playbackTime = null) {
    if (playbackTime !== null) {
      this._lastPlaybackTime = playbackTime;
    }
    const cursorTime = this._lastPlaybackTime;
    const { width, height } = this.canvas;
    const t = this._theme;
    this.ctx.fillStyle = t.canvasBg;
    this.ctx.fillRect(0, 0, width, height);

    if (this._liveImage) {
      this.ctx.putImageData(this._liveImage, 50, 0);
    } else if (this._spectBitmap) {
      this.ctx.drawImage(this._spectBitmap, 50, 0);
    } else if (this._spectImage) {
      this.ctx.putImageData(this._spectImage, 50, 0);
    }

    // Frequency axis
    this._drawFrequencyAxis(height);

    // Split view channel labels
    if (this.splitChannels && this._spectBitmap) {
      const spectHeight = height - 40;
      const halfHeight = Math.floor((spectHeight - 2) / 2);
      const channelLabels = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lb', 'Rb'];
      const labelA = (this.splitChannels[0] < channelLabels.length)
        ? `Ch ${this.splitChannels[0] + 1} (${channelLabels[this.splitChannels[0]]})`
        : `Ch ${this.splitChannels[0] + 1}`;
      const labelB = (this.splitChannels[1] < channelLabels.length)
        ? `Ch ${this.splitChannels[1] + 1} (${channelLabels[this.splitChannels[1]]})`
        : `Ch ${this.splitChannels[1] + 1}`;

      this.ctx.font = '10px monospace';
      this.ctx.textAlign = 'left';
      // Label A (top)
      this.ctx.fillStyle = t.labelBg;
      this.ctx.fillRect(52, 2, this.ctx.measureText(labelA).width + 6, 14);
      this.ctx.fillStyle = t.labelText;
      this.ctx.fillText(labelA, 55, 13);
      // Label B (bottom)
      const yB = halfHeight + 2;
      this.ctx.fillStyle = t.labelBg;
      this.ctx.fillRect(52, yB + 2, this.ctx.measureText(labelB).width + 6, 14);
      this.ctx.fillStyle = t.labelText;
      this.ctx.fillText(labelB, 55, yB + 13);
    }

    // Time axis
    this._drawTimeAxis(width, height);

    // File boundaries
    this._drawFileBoundaries(width, height);

    // Annotation regions on spectrogram + markers on timeline
    this._drawAnnotationRegions(width, height);
    this._drawAnnotationMarkers(width, height);

    // Selection highlight
    if (this.selectionStart !== null && this.selectionEnd !== null) {
      const selStart = Math.max(this.selectionStart, this.viewStart);
      const selEnd = Math.min(this.selectionEnd, this.viewEnd);
      if (selStart < selEnd) {
        const spectWidth = width - 60;
        const viewDuration = this.viewEnd - this.viewStart;
        const x1 = 50 + ((selStart - this.viewStart) / viewDuration) * spectWidth;
        const x2 = 50 + ((selEnd - this.viewStart) / viewDuration) * spectWidth;
        this.ctx.fillStyle = t.selection;
        this.ctx.fillRect(x1, 0, x2 - x1, height - 40);
        // Selection edges
        this.ctx.strokeStyle = t.selectionStroke;
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([3, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(x1, 0); this.ctx.lineTo(x1, height - 40);
        this.ctx.moveTo(x2, 0); this.ctx.lineTo(x2, height - 40);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }

    // Crosshair cursor
    if (this._hoverX !== null && this._hoverY !== null &&
        this._hoverX >= 50 && this._hoverX <= width - 10 &&
        this._hoverY >= 0 && this._hoverY < height - 40) {
      const isDark = t.canvasBg === '#1a1a1a' || t.canvasBg === '#000000' || t.canvasBg === '#111111';
      const lineColor = isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
      const labelBg = isDark ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.8)';
      const labelColor = isDark ? '#ccc' : '#333';

      this.ctx.save();
      this.ctx.setLineDash([4, 4]);
      this.ctx.strokeStyle = lineColor;
      this.ctx.lineWidth = 1;

      // Vertical line (time)
      this.ctx.beginPath();
      this.ctx.moveTo(this._hoverX, 0);
      this.ctx.lineTo(this._hoverX, height - 40);
      this.ctx.stroke();

      // Horizontal line (frequency)
      this.ctx.beginPath();
      this.ctx.moveTo(50, this._hoverY);
      this.ctx.lineTo(width - 10, this._hoverY);
      this.ctx.stroke();

      this.ctx.setLineDash([]);

      // Labels
      this.ctx.font = '10px monospace';
      const hoverTime = this.canvasXToTime(this._hoverX);
      const hoverFreq = this.canvasYToFreq(this._hoverY);

      // Time label at bottom of vertical line
      if (hoverTime >= this.viewStart && hoverTime <= this.viewEnd) {
        const timeStr = this._formatDuration(hoverTime);
        const tw = this.ctx.measureText(timeStr).width + 6;
        const tx = Math.min(this._hoverX - tw / 2, width - 10 - tw);
        this.ctx.fillStyle = labelBg;
        this.ctx.fillRect(Math.max(50, tx), height - 39, tw, 14);
        this.ctx.fillStyle = labelColor;
        this.ctx.textAlign = 'center';
        this.ctx.fillText(timeStr, Math.max(50 + tw / 2, this._hoverX), height - 28);
      }

      // Frequency label at left edge
      if (hoverFreq !== null) {
        const freqStr = hoverFreq >= 1000 ? (hoverFreq / 1000).toFixed(1) + ' kHz' : Math.round(hoverFreq) + ' Hz';
        this.ctx.fillStyle = labelBg;
        this.ctx.fillRect(0, this._hoverY - 7, 48, 14);
        this.ctx.fillStyle = labelColor;
        this.ctx.textAlign = 'right';
        this.ctx.fillText(freqStr, 46, this._hoverY + 4);
      }

      this.ctx.restore();
    }

    // Playback cursor
    if (cursorTime !== null && cursorTime !== undefined && cursorTime >= this.viewStart && cursorTime <= this.viewEnd) {
      const spectWidth = width - 60;
      const x = 50 + ((cursorTime - this.viewStart) / (this.viewEnd - this.viewStart)) * spectWidth;
      const cursorColor = this._getCursorColor();
      this.ctx.strokeStyle = cursorColor;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height - 40);
      this.ctx.stroke();
      // Small triangle marker at bottom
      this.ctx.fillStyle = cursorColor;
      this.ctx.beginPath();
      this.ctx.moveTo(x, height - 40);
      this.ctx.lineTo(x - 4, height - 34);
      this.ctx.lineTo(x + 4, height - 34);
      this.ctx.closePath();
      this.ctx.fill();
    }

    // Recording regions overlay (live mode)
    this._drawRecordingRegions(width, height);

    // Update overview minimap
    this._drawOverview();
  }

  _drawRecordingRegions(width, height) {
    if (!this._liveRecordRegions || this._liveRecordRegions.length === 0) return;
    if (!this._liveSamplesPerCol || !this._liveTotalCols) return;

    const plotH = height - 40;
    const w = this._liveW;
    const sampleToX = (s) => 50 + (s / this._liveSamplesPerCol) - this._liveTotalCols + w;

    const ctx = this.ctx;
    for (const region of this._liveRecordRegions) {
      const x1 = sampleToX(region.startSample);
      const endSample = region.endSample !== null
        ? region.endSample
        : (this._liveCapture ? this._liveCapture.totalSamples : region.startSample);
      const x2 = sampleToX(endSample);
      const rx1 = Math.max(50, x1);
      const rx2 = Math.min(width - 10, x2);
      if (rx2 <= rx1) continue;
      const rw = rx2 - rx1;
      const isActive = region.endSample === null;

      // Red top/bottom border bars (3px)
      ctx.fillStyle = isActive ? 'rgba(220, 40, 40, 0.85)' : 'rgba(220, 40, 40, 0.5)';
      ctx.fillRect(rx1, 0, rw, 3);
      ctx.fillRect(rx1, plotH - 3, rw, 3);

      // Start edge line (solid)
      if (x1 >= 50) {
        ctx.strokeStyle = 'rgba(220, 40, 40, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, plotH);
        ctx.stroke();
      }

      // End edge line
      if (x2 >= 50 && x2 <= width - 10) {
        ctx.strokeStyle = 'rgba(220, 40, 40, 0.6)';
        ctx.lineWidth = 1;
        ctx.setLineDash(isActive ? [] : [4, 4]);
        ctx.beginPath();
        ctx.moveTo(x2, 0);
        ctx.lineTo(x2, plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // "REC" / "● REC" label at start edge
      const labelX = Math.max(50 + 4, x1 + 4);
      if (labelX < rx2 - 20) {
        const label = isActive ? '\u25CF REC' : 'REC';
        ctx.font = 'bold 11px monospace';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(labelX - 2, 5, tw + 4, 14);
        ctx.fillStyle = isActive ? '#ff4444' : 'rgba(220, 100, 100, 0.8)';
        ctx.textAlign = 'left';
        ctx.fillText(label, labelX, 16);
      }
    }
  }

  _drawFileBoundaries(canvasWidth, canvasHeight) {
    if (!this.session || this.session.files.length <= 1) return;

    const spectWidth = canvasWidth - 60;
    const spectHeight = canvasHeight - 40;
    const viewDuration = this.viewEnd - this.viewStart;

    this.ctx.strokeStyle = this._theme.fileBoundary;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);

    for (const file of this.session.files) {
      if (file.timeStart > this.viewStart && file.timeStart < this.viewEnd) {
        const x = 50 + ((file.timeStart - this.viewStart) / viewDuration) * spectWidth;
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, spectHeight);
        this.ctx.stroke();

        // File label
        this.ctx.fillStyle = this._theme.fileLabel;
        this.ctx.font = '9px monospace';
        this.ctx.textAlign = 'left';
        this.ctx.fillText(file.fileName, x + 3, 12);
      }
    }
    this.ctx.setLineDash([]);
  }

  _drawAnnotationMarkers(canvasWidth, canvasHeight) {
    if (this.annotations.length === 0) return;

    const spectWidth = canvasWidth - 60;
    const axisY = canvasHeight - 40;
    const viewDuration = this.viewEnd - this.viewStart;

    for (const ann of this.annotations) {
      // Check if annotation overlaps the view
      if (ann.sessionEnd < this.viewStart || ann.sessionStart > this.viewEnd) continue;

      const x1 = 50 + Math.max(0, ((ann.sessionStart - this.viewStart) / viewDuration) * spectWidth);
      const x2 = 50 + Math.min(spectWidth, ((ann.sessionEnd - this.viewStart) / viewDuration) * spectWidth);
      const barW = Math.max(3, x2 - x1);

      // Draw a small colored bar in the time axis area
      this.ctx.fillStyle = this._theme.orange + '99';
      this.ctx.fillRect(x1, axisY - 4, barW, 4);

      // Draw label if there's room
      if (barW > 20) {
        this.ctx.fillStyle = this._theme.orange + 'dd';
        this.ctx.font = '9px sans-serif';
        this.ctx.textAlign = 'left';
        const labelX = x1 + 2;
        const maxW = barW - 4;
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(x1, axisY - 18, barW, 14);
        this.ctx.clip();
        this.ctx.fillText(ann.note, labelX, axisY - 7);
        this.ctx.restore();
      }
    }
  }

  _drawAnnotationRegions(canvasWidth, canvasHeight) {
    if (this.annotations.length === 0) return;

    const spectWidth = canvasWidth - 60;
    const spectHeight = canvasHeight - 40;
    const viewDuration = this.viewEnd - this.viewStart;

    // Assign colors to annotations for visual distinction
    const colors = [
      [255, 152, 0],   // orange
      [0, 188, 212],   // cyan
      [156, 39, 176],  // purple
      [76, 175, 80],   // green
      [255, 87, 34],   // deep orange
      [33, 150, 243],  // blue
      [255, 235, 59],  // yellow
      [233, 30, 99],   // pink
    ];

    // Count overlaps at each annotation to stack labels
    const visibleAnns = [];
    for (let i = 0; i < this.annotations.length; i++) {
      const ann = this.annotations[i];
      if (ann.sessionEnd < this.viewStart || ann.sessionStart > this.viewEnd) continue;

      const x1 = 50 + Math.max(0, ((ann.sessionStart - this.viewStart) / viewDuration) * spectWidth);
      const x2 = 50 + Math.min(spectWidth, ((ann.sessionEnd - this.viewStart) / viewDuration) * spectWidth);
      if (x2 - x1 < 1) continue;

      visibleAnns.push({ ann, x1, x2, colorIdx: i % colors.length });
    }

    // Draw semi-transparent region overlays
    for (const { ann, x1, x2, colorIdx } of visibleAnns) {
      const [r, g, b] = colors[colorIdx];
      const w = x2 - x1;

      // Fill region with very subtle tint
      this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.08)`;
      this.ctx.fillRect(x1, 0, w, spectHeight);

      // Draw left/right border lines
      this.ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.4)`;
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([4, 4]);
      this.ctx.beginPath();
      this.ctx.moveTo(x1, 0); this.ctx.lineTo(x1, spectHeight);
      this.ctx.moveTo(x2, 0); this.ctx.lineTo(x2, spectHeight);
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    // Draw labels - stack overlapping ones vertically
    // Sort by start position for consistent label stacking
    visibleAnns.sort((a, b) => a.x1 - b.x1);

    const labelHeight = 16;
    const usedSlots = []; // [{x1, x2, row}] to detect overlap

    for (const { ann, x1, x2, colorIdx } of visibleAnns) {
      const [r, g, b] = colors[colorIdx];

      // Find a row that doesn't overlap with existing labels
      let row = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const conflict = usedSlots.some(s =>
          s.row === attempt && !(x2 < s.x1 || x1 > s.x2)
        );
        if (!conflict) { row = attempt; break; }
        row = attempt + 1;
      }

      usedSlots.push({ x1, x2, row });

      const labelY = 4 + row * (labelHeight + 2);
      if (labelY + labelHeight > spectHeight) continue; // Skip if too many stacked

      // Label background
      const label = ann.note;
      this.ctx.font = '10px sans-serif';
      const textW = Math.min(this.ctx.measureText(label).width + 8, x2 - x1);

      this.ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
      const bw = Math.max(textW, 20);
      if (this.ctx.roundRect) {
        this.ctx.beginPath();
        this.ctx.roundRect(x1, labelY, bw, labelHeight, 2);
        this.ctx.fill();
      } else {
        this.ctx.fillRect(x1, labelY, bw, labelHeight);
      }

      // Label text
      this.ctx.fillStyle = t.labelText;
      this.ctx.textAlign = 'left';
      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.rect(x1, labelY, bw - 2, labelHeight);
      this.ctx.clip();
      this.ctx.fillText(label, x1 + 3, labelY + 12);
      this.ctx.restore();
    }
  }

  _drawFrequencyAxis(canvasHeight) {
    this.ctx.fillStyle = this._theme.canvasBg;
    this.ctx.fillRect(0, 0, 50, canvasHeight);
    this.ctx.fillStyle = this._theme.axisText;
    this.ctx.font = '9px monospace';
    this.ctx.textAlign = 'right';
    this.ctx.strokeStyle = this._theme.axisGrid;
    this.ctx.lineWidth = 1;

    const spectHeight = canvasHeight - 40;

    if (this.logFrequency) {
      const logMin = Math.log(Math.max(this.minFreq, 20));
      const logMax = Math.log(Math.max(this.maxFreq, 21));
      const niceFreqs = [20, 30, 50, 75, 100, 150, 200, 300, 500, 750,
        1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000, 20000, 30000, 50000, 80000];
      for (const freq of niceFreqs) {
        if (freq < this.minFreq || freq > this.maxFreq) continue;
        const ratio = (Math.log(freq) - logMin) / (logMax - logMin);
        const y = (1 - ratio) * spectHeight;
        // Major vs minor labels
        const isMajor = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000].includes(freq);
        if (isMajor) {
          let label = freq >= 1000 ? (freq / 1000).toFixed(freq >= 10000 ? 0 : 1) + 'k' : freq.toString();
          this.ctx.fillStyle = this._theme.axisText;
          this.ctx.fillText(label, 44, y + 3);
          // Tick mark
          this.ctx.beginPath();
          this.ctx.moveTo(48, y);
          this.ctx.lineTo(50, y);
          this.ctx.stroke();
        } else {
          // Minor tick
          this.ctx.beginPath();
          this.ctx.moveTo(49, y);
          this.ctx.lineTo(50, y);
          this.ctx.stroke();
        }
      }
    } else {
      // Linear scale: pick nice intervals based on the frequency range
      const range = this.maxFreq - this.minFreq;
      const niceIntervals = [10, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
      // Target: one label per ~40 pixels
      const targetCount = Math.max(4, Math.floor(spectHeight / 40));
      const rawInterval = range / targetCount;
      const interval = niceIntervals.find(i => i >= rawInterval) || 10000;

      // Minor interval for tick marks (half or fifth of major)
      const minorInterval = interval <= 100 ? interval / 2 :
                            interval <= 1000 ? interval / 5 : interval / 5;

      const startFreq = Math.ceil(this.minFreq / minorInterval) * minorInterval;

      for (let freq = startFreq; freq <= this.maxFreq; freq += minorInterval) {
        const ratio = (freq - this.minFreq) / range;
        const y = (1 - ratio) * spectHeight;
        const isMajor = Math.abs(freq % interval) < 0.5 || Math.abs(freq % interval - interval) < 0.5;

        if (isMajor) {
          let label;
          if (freq >= 10000) {
            label = (freq / 1000).toFixed(0) + 'k';
          } else if (freq >= 1000) {
            label = (freq / 1000).toFixed(1) + 'k';
          } else {
            label = Math.round(freq).toString();
          }
          this.ctx.fillStyle = this._theme.axisText;
          this.ctx.fillText(label, 44, y + 3);
          this.ctx.beginPath();
          this.ctx.moveTo(48, y);
          this.ctx.lineTo(50, y);
          this.ctx.stroke();
        } else {
          // Minor tick
          this.ctx.beginPath();
          this.ctx.moveTo(49, y);
          this.ctx.lineTo(50, y);
          this.ctx.stroke();
        }
      }
    }
  }

  _drawTimeAxis(canvasWidth, canvasHeight) {
    const axisY = canvasHeight - 40;
    const th = this._theme;
    this.ctx.fillStyle = th.canvasBg;
    this.ctx.fillRect(0, axisY, canvasWidth, 40);
    this.ctx.fillStyle = th.axisText;
    this.ctx.font = '11px monospace';
    this.ctx.textAlign = 'center';

    const viewDuration = this.viewEnd - this.viewStart;
    const spectWidth = canvasWidth - 60;

    if (this._liveCapture) {
      // Live mode: fixed pixel-position ticks (no drift).
      // Labels show negative seconds from "now" (right edge).
      const numTicks = Math.max(2, Math.floor(spectWidth / 100));
      for (let i = 0; i <= numTicks; i++) {
        const frac = i / numTicks;
        const t = this.viewStart + frac * viewDuration;
        const x = 50 + frac * spectWidth;

        this.ctx.strokeStyle = th.tick;
        this.ctx.beginPath();
        this.ctx.moveTo(x, axisY);
        this.ctx.lineTo(x, axisY + 5);
        this.ctx.stroke();

        const secsFromNow = t - this.totalDuration;
        const label = secsFromNow >= -0.05 ? '0s' : secsFromNow.toFixed(1) + 's';
        this.ctx.fillStyle = th.axisText;
        this.ctx.fillText(label, x, axisY + 20);
      }
    } else {
      const targetTicks = 10;
      const rawInterval = viewDuration / targetTicks;
      const niceIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
      const interval = niceIntervals.find(i => i >= rawInterval) || 3600;

      const startTick = Math.ceil(this.viewStart / interval) * interval;
      const hasWallClock = this.session && this.session.sessionStartTime !== null;

      for (let t = startTick; t <= this.viewEnd; t += interval) {
        const x = 50 + ((t - this.viewStart) / viewDuration) * spectWidth;

        this.ctx.strokeStyle = th.tick;
        this.ctx.beginPath();
        this.ctx.moveTo(x, axisY);
        this.ctx.lineTo(x, axisY + 5);
        this.ctx.stroke();

        if (hasWallClock) {
          const wallSec = this.session.toWallClock(t);
          if (wallSec !== null) {
            this.ctx.fillStyle = th.wallTime;
            this.ctx.fillText(this._formatWallTime(wallSec), x, axisY + 18);
          }
          this.ctx.fillStyle = th.dimText;
          this.ctx.font = '9px monospace';
          this.ctx.fillText(this._formatDuration(t), x, axisY + 32);
          this.ctx.font = '11px monospace';
        } else {
          this.ctx.fillStyle = th.axisText;
          this.ctx.fillText(this._formatDuration(t), x, axisY + 20);
        }
      }
    }
  }

  _formatWallTime(seconds) {
    // Handle times > 24h (next day)
    const s = ((seconds % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  _formatDuration(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Get a cursor color that contrasts well with the current colormap.
   */
  _getCursorColor() {
    const contrastColors = {
      viridis: '#ff4444',    // red contrasts with blue-green-yellow
      magma: '#00ff88',      // green contrasts with purple-orange
      inferno: '#00ccff',    // cyan contrasts with red-yellow
      grayscale: '#ff4444',  // red contrasts with gray
      green: '#ff44ff',      // magenta contrasts with green
      hot: '#00ccff'         // cyan contrasts with red-yellow-white
    };
    return contrastColors[this.colorPreset] || '#ff4444';
  }

  /**
   * Colormap lookup with preset support.
   */
  _colorize(value) {
    const presets = {
      viridis: [
        [0.0, 0, 0, 0], [0.10, 8, 8, 30], [0.20, 50, 55, 125], [0.25, 65, 68, 135],
        [0.38, 53, 95, 141], [0.50, 42, 120, 142], [0.63, 33, 145, 140],
        [0.75, 34, 168, 132], [0.82, 68, 191, 112], [0.88, 122, 209, 81],
        [0.94, 189, 223, 38], [1.0, 253, 231, 37]
      ],
      magma: [
        [0.0, 0, 0, 0], [0.08, 5, 3, 20], [0.15, 28, 16, 68], [0.25, 79, 18, 123],
        [0.38, 129, 37, 129], [0.50, 181, 54, 122], [0.63, 229, 89, 100],
        [0.75, 251, 136, 97], [0.85, 254, 188, 118], [0.94, 254, 228, 152],
        [1.0, 252, 253, 191]
      ],
      inferno: [
        [0.0, 0, 0, 0], [0.08, 5, 3, 20], [0.15, 31, 12, 72], [0.25, 85, 15, 109],
        [0.38, 136, 34, 106], [0.50, 186, 54, 85], [0.63, 227, 89, 51],
        [0.75, 249, 140, 10], [0.85, 249, 201, 50], [0.94, 240, 249, 33],
        [1.0, 252, 255, 164]
      ],
      grayscale: [
        [0.0, 0, 0, 0], [1.0, 255, 255, 255]
      ],
      green: [
        [0.0, 0, 0, 0], [0.25, 0, 30, 0], [0.5, 0, 100, 10],
        [0.75, 30, 200, 30], [1.0, 180, 255, 100]
      ],
      hot: [
        [0.0, 0, 0, 0], [0.33, 180, 0, 0], [0.66, 255, 200, 0],
        [1.0, 255, 255, 255]
      ]
    };

    const stops = presets[this.colorPreset] || presets.viridis;

    for (let i = 0; i < stops.length - 1; i++) {
      if (value <= stops[i + 1][0]) {
        const t = (value - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
        return [
          Math.round(stops[i][1] + t * (stops[i + 1][1] - stops[i][1])),
          Math.round(stops[i][2] + t * (stops[i + 1][2] - stops[i][2])),
          Math.round(stops[i][3] + t * (stops[i + 1][3] - stops[i][3]))
        ];
      }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
  }

  setView(start, end) {
    const duration = end - start;
    // Use trim bounds if active, otherwise full session
    const lo = this.trimStart != null ? this.trimStart : 0;
    const hi = this.trimEnd != null ? this.trimEnd : this.totalDuration;
    // Clamp while preserving view duration (prevents accidental zoom at boundaries)
    if (start < lo) {
      start = lo;
      end = Math.min(start + duration, hi);
    }
    if (end > hi) {
      end = hi;
      start = Math.max(lo, end - duration);
    }
    this.viewStart = start;
    this.viewEnd = end;
    this.draw();
    this._updateScrollbar();
    if (this.onViewChange) this.onViewChange(this.viewStart, this.viewEnd);
  }

  zoom(centerTime, factor) {
    const currentDuration = this.viewEnd - this.viewStart;
    const maxDur = this.trimEnd != null ? (this.trimEnd - this.trimStart) : this.totalDuration;
    const newDuration = Math.max(0.5, Math.min(maxDur, currentDuration * factor));
    // Always center on the target time (both zoom in and out)
    const newStart = centerTime - newDuration / 2;
    this.setView(newStart, newStart + newDuration);
  }

  canvasXToTime(x) {
    const spectWidth = this.canvas.width - 60;
    const ratio = (x - 50) / spectWidth;
    return this.viewStart + ratio * (this.viewEnd - this.viewStart);
  }

  canvasYToFreq(y) {
    const spectHeight = this.canvas.height - 40;
    if (y < 0 || y >= spectHeight) return null;
    const ratio = 1 - (y / spectHeight); // 0=minFreq, 1=maxFreq

    if (this.logFrequency) {
      const logMin = Math.log(Math.max(this.minFreq, 20));
      const logMax = Math.log(Math.max(this.maxFreq, 21));
      return Math.exp(logMin + ratio * (logMax - logMin));
    }
    return this.minFreq + ratio * (this.maxFreq - this.minFreq);
  }

  /**
   * Re-render the spectrogram image from cached FFT data (instant).
   * Use this when gain or dynamic range changes - no FFT recomputation needed.
   */
  async rerender() {
    if (this._lastFFTDataSplit) {
      await this._renderSplitSpectrogram(this._lastFFTDataSplit[0], this._lastFFTDataSplit[1]);
      this.draw();
    } else if (this._lastFFTData) {
      await this._renderSpectrogram(this._lastFFTData);
      this.draw();
    }
  }

  _setupScrollbar() {
    this._scrollbar = document.getElementById('time-scrollbar');
    this._scrollThumb = document.getElementById('time-scrollbar-thumb');
    if (!this._scrollbar || !this._scrollThumb) return;

    let isDragging = false;
    let dragStartX = 0;
    let dragStartLeft = 0;

    this._scrollThumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      dragStartX = e.clientX;
      dragStartLeft = this._scrollThumb.offsetLeft;
      document.body.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const trackWidth = this._scrollbar.clientWidth;
      const thumbWidth = this._scrollThumb.offsetWidth;
      const maxLeft = trackWidth - thumbWidth;
      const dx = e.clientX - dragStartX;
      const newLeft = Math.max(0, Math.min(maxLeft, dragStartLeft + dx));
      const ratio = maxLeft > 0 ? newLeft / maxLeft : 0;
      const viewDuration = this.viewEnd - this.viewStart;
      const range = this.trimEnd != null ? (this.trimEnd - this.trimStart) : this.totalDuration;
      const rangeStart = this.trimStart != null ? this.trimStart : 0;
      const newStart = rangeStart + ratio * (range - viewDuration);
      this.setView(newStart, newStart + viewDuration);
      clearTimeout(this._scrollComputeTimeout);
      this._scrollComputeTimeout = setTimeout(() => this.computeVisible(), 150);
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        document.body.style.cursor = '';
      }
    });

    // Click on track to jump
    this._scrollbar.addEventListener('mousedown', (e) => {
      if (e.target === this._scrollThumb) return;
      const rect = this._scrollbar.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const trackWidth = this._scrollbar.clientWidth;
      const viewDuration = this.viewEnd - this.viewStart;
      const range = this.trimEnd != null ? (this.trimEnd - this.trimStart) : this.totalDuration;
      const rangeStart = this.trimStart != null ? this.trimStart : 0;
      const thumbWidth = (viewDuration / range) * trackWidth;
      const maxLeft = trackWidth - thumbWidth;
      const newLeft = Math.max(0, Math.min(maxLeft, clickX - thumbWidth / 2));
      const ratio = maxLeft > 0 ? newLeft / maxLeft : 0;
      const newStart = rangeStart + ratio * (range - viewDuration);
      this.setView(newStart, newStart + viewDuration);
      clearTimeout(this._scrollComputeTimeout);
      this._scrollComputeTimeout = setTimeout(() => this.computeVisible(), 150);
    });
  }

  _updateScrollbar() {
    if (!this._scrollbar || !this._scrollThumb) return;
    const trackWidth = this._scrollbar.clientWidth;
    const viewDuration = this.viewEnd - this.viewStart;
    const range = this.trimEnd != null ? (this.trimEnd - this.trimStart) : this.totalDuration;
    const rangeStart = this.trimStart != null ? this.trimStart : 0;
    const thumbRatio = Math.min(1, viewDuration / range);
    const thumbWidth = Math.max(30, thumbRatio * trackWidth);
    const maxLeft = trackWidth - thumbWidth;
    const scrollableRange = range - viewDuration;
    const posRatio = scrollableRange > 0 ? (this.viewStart - rangeStart) / scrollableRange : 0;
    this._scrollThumb.style.width = thumbWidth + 'px';
    this._scrollThumb.style.left = (posRatio * maxLeft) + 'px';
    // Hide scrollbar when viewing full duration
    this._scrollbar.style.display = thumbRatio >= 0.99 ? 'none' : 'block';
  }

  // --- Waveform overview / minimap ---

  setOverviewCanvas(canvas) {
    this._overviewCanvas = canvas;
    this._overviewCtx = canvas.getContext('2d');
    this._overviewData = null;
    this._overviewDragging = false;

    canvas.addEventListener('mousedown', (e) => {
      this._overviewDragging = true;
      this._overviewNavigate(e.offsetX);
    });
    canvas.addEventListener('mousemove', (e) => {
      if (this._overviewDragging) this._overviewNavigate(e.offsetX);
    });
    canvas.addEventListener('mouseup', () => { this._overviewDragging = false; });
    canvas.addEventListener('mouseleave', () => { this._overviewDragging = false; });

    new ResizeObserver(() => {
      canvas.width = Math.floor(canvas.clientWidth);
      canvas.height = 30;
      if (this._overviewData) this._drawOverview();
    }).observe(canvas);
  }

  _overviewNavigate(x) {
    if (!this._overviewCanvas || !this.session) return;
    const frac = x / this._overviewCanvas.width;
    const centerTime = frac * this.totalDuration;
    const viewDuration = this.viewEnd - this.viewStart;
    let newStart = centerTime - viewDuration / 2;
    let newEnd = newStart + viewDuration;
    if (newStart < 0) { newEnd -= newStart; newStart = 0; }
    if (newEnd > this.totalDuration) { newStart -= (newEnd - this.totalDuration); newEnd = this.totalDuration; }
    this.setView(Math.max(0, newStart), newEnd);
    clearTimeout(this._overviewComputeTimeout);
    this._overviewComputeTimeout = setTimeout(() => this.computeVisible(), 150);
  }

  async computeOverview() {
    if (!this.session || !this._overviewCanvas) return;
    const w = this._overviewCanvas.clientWidth || 800;
    if (w <= 0) return;

    const totalSamples = Math.floor(this.totalDuration * this.session.sampleRate);
    const blocksPerPixel = Math.max(1, Math.floor(totalSamples / w));
    const data = new Float32Array(w);

    // Read in small chunks with yields to avoid starving the audio server
    const chunkPixels = 50;
    const chunkSamples = chunkPixels * blocksPerPixel;

    for (let px = 0; px < w; px += chunkPixels) {
      const startSample = px * blocksPerPixel;
      const count = Math.min(chunkSamples, totalSamples - startSample);
      if (count <= 0) break;

      // Yield to let the audio HTTP server handle playback requests
      await new Promise(r => setTimeout(r, 20));

      if (this.onOverviewProgress) {
        this.onOverviewProgress(Math.round((px / w) * 100));
      }

      try {
        const samples = await this._readPCMRange(startSample, count, true);
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

    if (this.onOverviewProgress) {
      this.onOverviewProgress(null); // done
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
    const t = this._theme;
    const isDark = t.canvasBg === '#1a1a1a' || t.canvasBg === '#000000' || t.canvasBg === '#111111';
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
    if (this.totalDuration > 0) {
      const vx1 = (this.viewStart / this.totalDuration) * w;
      const vx2 = (this.viewEnd / this.totalDuration) * w;
      ctx.fillStyle = isDark ? 'rgba(90,159,212,0.25)' : 'rgba(58,122,191,0.2)';
      ctx.fillRect(vx1, 0, vx2 - vx1, h);
      ctx.strokeStyle = isDark ? 'rgba(90,159,212,0.6)' : 'rgba(58,122,191,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(vx1, 0, vx2 - vx1, h);

      // Dim outside trim bounds
      if (this.trimStart != null && this.trimEnd != null) {
        const tx1 = (this.trimStart / this.totalDuration) * w;
        const tx2 = (this.trimEnd / this.totalDuration) * w;
        ctx.fillStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.5)';
        ctx.fillRect(0, 0, tx1, h);
        ctx.fillRect(tx2, 0, w - tx2, h);
      }

      // Playback cursor
      if (this._lastPlaybackTime !== null) {
        const cx = (this._lastPlaybackTime / this.totalDuration) * w;
        ctx.strokeStyle = this._getCursorColor();
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
      }
    }
  }

  _setupInteraction() {
    let computeTimeout = null;

    const scheduleCompute = () => {
      clearTimeout(computeTimeout);
      computeTimeout = setTimeout(() => this.computeVisible(), 150);
    };

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();

      // Pinch-to-zoom (ctrlKey+wheel) → zoom
      if (e.ctrlKey) {
        let time;
        if (this._lastPlaybackTime !== null && this._lastPlaybackTime !== undefined) {
          time = this._lastPlaybackTime;
        } else {
          const rect = this.canvas.getBoundingClientRect();
          const canvasX = e.clientX - rect.left;
          time = this.canvasXToTime(canvasX);
        }
        const factor = 1 + e.deltaY * 0.02;
        this.zoom(time, factor);
        scheduleCompute();
        return;
      }

      // Any non-pinch scroll → pan in time (horizontal component)
      // Use deltaX if available, otherwise ignore vertical-only scroll
      const dx = e.deltaX || 0;
      if (dx === 0 && e.deltaY !== 0) return; // pure vertical scroll — ignore
      const viewDuration = this.viewEnd - this.viewStart;
      const panAmount = (dx / this.canvas.width) * viewDuration * 2;
      const newStart = this.viewStart + panAmount;
      this.setView(newStart, newStart + viewDuration);
      scheduleCompute();
    });

    // Prevent context menu on right-click (used for panning)
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        // Right-click: pan mode
        this.isDragging = true;
        this.dragStartX = e.offsetX;
        this.dragStartViewStart = this.viewStart;
        this.canvas.style.cursor = 'grabbing';
      } else if (e.button === 0) {
        // Left-click: selection mode
        this._isSelecting = true;
        this._selectStartX = e.offsetX;
        const time = this.canvasXToTime(e.offsetX);
        this.selectionStart = time;
        this.selectionEnd = time;
        this.canvas.style.cursor = 'col-resize';
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this._isSelecting) {
        const time = this.canvasXToTime(e.offsetX);
        this.selectionEnd = time;
        this.draw();
      } else if (this.isDragging) {
        const dx = e.offsetX - this.dragStartX;
        const spectWidth = this.canvas.width - 60;
        const timeDelta = -(dx / spectWidth) * (this.viewEnd - this.viewStart);
        const duration = this.viewEnd - this.viewStart;
        const newStart = this.dragStartViewStart + timeDelta;
        this.setView(newStart, newStart + duration);
        scheduleCompute();
      }

      // Report cursor position (time + frequency) + track crosshair
      const rect = this.canvas.getBoundingClientRect();
      this._hoverX = e.clientX - rect.left;
      this._hoverY = e.clientY - rect.top;
      if (this.onCursorMove) {
        const time = this.canvasXToTime(this._hoverX);
        const freq = this.canvasYToFreq(this._hoverY);
        this.onCursorMove(time, freq);
      }
      if (!this._isSelecting && !this.isDragging) {
        this.draw();
      }
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (this._isSelecting) {
        this._isSelecting = false;
        this.canvas.style.cursor = 'crosshair';
        // Check if this was a click (no drag) vs a drag selection
        const wasDrag = Math.abs(e.offsetX - this._selectStartX) > 3;
        if (wasDrag) {
          // Normalize so start < end
          if (this.selectionStart > this.selectionEnd) {
            [this.selectionStart, this.selectionEnd] = [this.selectionEnd, this.selectionStart];
          }
          // Only keep selection if meaningful (> 0.1s)
          if (this.selectionEnd - this.selectionStart < 0.1) {
            this.selectionStart = null;
            this.selectionEnd = null;
          }
          this.draw();
          if (this.onSelectionChange) {
            this.onSelectionChange(this.selectionStart, this.selectionEnd);
          }
        } else {
          // Click without drag: seek to position, clear selection
          this.selectionStart = null;
          this.selectionEnd = null;
          if (this.onSelectionChange) this.onSelectionChange(null, null);
          const time = this.canvasXToTime(e.offsetX);
          if (this.onTimeClick && time >= 0 && time <= this.totalDuration) {
            this.onTimeClick(time);
          }
        }
        return;
      }
      if (this.isDragging) {
        this.isDragging = false;
        this.canvas.style.cursor = 'crosshair';
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this._isSelecting = false;
      this.isDragging = false;
      this._hoverX = null;
      this._hoverY = null;
      this.canvas.style.cursor = 'crosshair';
      if (this.onCursorMove) this.onCursorMove(null, null);
      this.draw();
    });
  }

  // --- Live input mode (column-cached rendering) ---

  _liveCapture = null;
  _liveRAF = null;
  _liveScrolling = true;
  _liveViewSeconds = 10;
  _liveColCache = null;
  _liveLastCol = 0;
  _liveWindowNormDB = 0;
  _liveRecordRegions = []; // [{startSample, endSample|null}] for recording overlay
  _liveSamplesPerCol = 0;
  _liveTotalCols = 0;
  _liveW = 0;
  _liveYBins = null;
  _liveYFracs = null;
  _liveYBinsKey = '';
  _liveMaxBin = 0;
  _liveColorLUT = null;
  _liveLUTPreset = null;
  _liveImageData = null;
  _liveImageW = 0;
  _liveImageH = 0;

  setLiveSource(liveCapture) {
    this.stopLive();
    this._liveCapture = liveCapture;

    this.session = null;
    this.totalDuration = 0;
    this.viewStart = 0;
    this.viewEnd = 0;
    this.selectionStart = null;
    this.selectionEnd = null;
    this.tileCache.clear();
    this._lastFFTData = null;
    this._lastFFTDataSplit = null;
    this._liveScrolling = true;
    this._liveLastCol = 0;
    this._liveColCache = null;
    this._liveRecordRegions = [];

    this._ensureLiveWindow(this.fftSize);
    this._liveRenderLoop();
  }

  startRecordingRegion() {
    const sample = this._liveCapture ? this._liveCapture.totalSamples : 0;
    this._liveRecordRegions.push({ startSample: sample, endSample: null });
  }

  stopRecordingRegion() {
    const sample = this._liveCapture ? this._liveCapture.totalSamples : 0;
    const active = this._liveRecordRegions.find(r => r.endSample === null);
    if (active) active.endSample = sample;
  }

  _liveRenderLoop() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;

    const sr = this._liveCapture.sampleRate;
    const total = this._liveCapture.totalSamples;
    const totalDur = total / sr;
    this.totalDuration = totalDur;

    const viewSec = this._liveViewSeconds;

    if (this._liveScrolling) {
      this.viewEnd = totalDur;
      this.viewStart = Math.max(0, totalDur - viewSec);
    }

    const w = this.canvas.width - 60;
    const h = this.canvas.height - 40;

    if (w > 0 && h > 0 && total > this.fftSize) {
      const viewSamples = Math.floor(viewSec * sr);
      const samplesPerCol = viewSamples / w;
      const totalCols = Math.floor(total / samplesPerCol);

      // Save for recording region overlay in draw()
      this._liveSamplesPerCol = samplesPerCol;
      this._liveTotalCols = totalCols;
      this._liveW = w;

      if (!this._liveColCache || this._liveColCache.length !== w) {
        this._liveColCache = new Array(w).fill(null);
        this._liveLastCol = 0;
      }

      // Rebuild window if type changed during capture
      const N = this.fftSize;
      const prevWindowType = this._liveWindowType;
      this._ensureLiveWindow(N);
      if (prevWindowType && prevWindowType !== this._liveWindowType) {
        // Force recompute all visible columns with new window
        this._liveColCache = new Array(w).fill(null);
        this._liveLastCol = 0;
      }
      const windowed = new Float32Array(N);
      const gainLin = Math.pow(10, this.inputGainDB / 20);  // audio input gain
      // Invalidate cache when input gain changes
      if (this._liveInputGainDB !== this.inputGainDB) {
        this._liveInputGainDB = this.inputGainDB;
        this._liveColCache = new Array(w).fill(null);
        this._liveLastCol = 0;
      }
      const newStart = Math.max(this._liveLastCol, Math.max(0, totalCols - w));

      for (let col = newStart; col < totalCols; col++) {
        const centerSample = Math.floor((col + 0.5) * samplesPerCol);
        // Clamp FFT window to available data — prevents zero-padding at edges
        // which causes broadband spectral leakage (visible as vertical lines)
        let fftStart = centerSample - Math.floor(N / 2);
        if (fftStart + N > total) fftStart = total - N;
        if (fftStart < 0) fftStart = 0;

        for (let i = 0; i < N; i++) {
          windowed[i] = this._liveCapture.readSample(fftStart + i) * gainLin * this._liveWindow[i];
        }

        this._liveColCache[col % w] = this._fftFrame(windowed);
      }
      this._liveLastCol = totalCols;

      // Render full frame from cache
      this._renderLiveFrame(w, h, totalCols, sr);
      this.draw();
    }

    if (this._liveCapture && this._liveCapture.isCapturing) {
      this._liveRAF = requestAnimationFrame(() => this._liveRenderLoop());
    }
  }

  _buildLiveColorLUT() {
    const presets = {
      viridis: [
        [0.0, 0, 0, 0], [0.10, 8, 8, 30], [0.20, 50, 55, 125], [0.25, 65, 68, 135],
        [0.38, 53, 95, 141], [0.50, 42, 120, 142], [0.63, 33, 145, 140],
        [0.75, 34, 168, 132], [0.82, 68, 191, 112], [0.88, 122, 209, 81],
        [0.94, 189, 223, 38], [1.0, 253, 231, 37]
      ],
      magma: [
        [0.0, 0, 0, 0], [0.08, 5, 3, 20], [0.15, 28, 16, 68], [0.25, 79, 18, 123],
        [0.38, 129, 37, 129], [0.50, 181, 54, 122], [0.63, 229, 89, 100],
        [0.75, 251, 136, 97], [0.85, 254, 188, 118], [0.94, 254, 228, 152],
        [1.0, 252, 253, 191]
      ],
      inferno: [
        [0.0, 0, 0, 0], [0.08, 5, 3, 20], [0.15, 31, 12, 72], [0.25, 85, 15, 109],
        [0.38, 136, 34, 106], [0.50, 186, 54, 85], [0.63, 227, 89, 51],
        [0.75, 249, 140, 10], [0.85, 249, 201, 50], [0.94, 240, 249, 33],
        [1.0, 252, 255, 164]
      ],
      grayscale: [
        [0.0, 0, 0, 0], [1.0, 255, 255, 255]
      ],
      green: [
        [0.0, 0, 0, 0], [0.25, 0, 30, 0], [0.5, 0, 100, 10],
        [0.75, 30, 200, 30], [1.0, 180, 255, 100]
      ],
      hot: [
        [0.0, 0, 0, 0], [0.33, 180, 0, 0], [0.66, 255, 200, 0],
        [1.0, 255, 255, 255]
      ]
    };
    const stops = presets[this.colorPreset] || presets.viridis;
    const lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const value = i / 255;
      let r = 0, g = 0, b = 0;
      for (let s = 0; s < stops.length - 1; s++) {
        if (value <= stops[s + 1][0]) {
          const t = (value - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
          r = Math.round(stops[s][1] + t * (stops[s + 1][1] - stops[s][1]));
          g = Math.round(stops[s][2] + t * (stops[s + 1][2] - stops[s][2]));
          b = Math.round(stops[s][3] + t * (stops[s + 1][3] - stops[s][3]));
          break;
        }
        if (s === stops.length - 2) {
          const last = stops[stops.length - 1];
          r = last[1]; g = last[2]; b = last[3];
        }
      }
      const off = i * 4;
      lut[off] = r;
      lut[off + 1] = g;
      lut[off + 2] = b;
      lut[off + 3] = 255;
    }
    this._liveColorLUT = lut;
    this._liveLUTPreset = this.colorPreset;
  }

  _renderLiveFrame(w, h, totalCols, sr) {
    const N = this.fftSize;
    const freqBins = N / 2;
    const floor = -this.dynamicRangeDB;

    // Build or reuse Y→bin mapping
    const binRes = sr / N;
    const minBin = Math.max(1, Math.floor(this.minFreq / binRes));
    const maxBin = Math.min(Math.ceil(this.maxFreq / binRes), freqBins - 1);
    const visibleBins = maxBin - minBin;
    const yKey = `${h}_${this.minFreq}_${this.maxFreq}_${sr}_${this.logFrequency}_${N}`;

    if (this._liveYBinsKey !== yKey) {
      const logMinFreq = Math.log(Math.max(this.minFreq, 20));
      const logMaxFreq = Math.log(Math.max(this.maxFreq, 21));
      const yBins = new Float64Array(h);
      const yFracs = new Float32Array(h);
      for (let y = 0; y < h; y++) {
        const ratio = (h - 1 - y) / h;
        let binF;
        if (this.logFrequency) {
          const logFreq = logMinFreq + ratio * (logMaxFreq - logMinFreq);
          binF = Math.exp(logFreq) / binRes;
        } else {
          binF = minBin + ratio * visibleBins;
        }
        binF = Math.max(minBin, Math.min(binF, maxBin));
        yBins[y] = Math.floor(binF);
        yFracs[y] = binF - Math.floor(binF);
      }
      this._liveYBins = yBins;
      this._liveYFracs = yFracs;
      this._liveYBinsKey = yKey;
      this._liveMaxBin = maxBin;
    }
    const yBins = this._liveYBins;
    const yFracs = this._liveYFracs;
    const maxBinCached = this._liveMaxBin;

    // Build or refresh color LUT (256-entry table replaces per-pixel _colorize calls)
    if (!this._liveColorLUT || this._liveLUTPreset !== this.colorPreset) {
      this._buildLiveColorLUT();
    }
    const lut = this._liveColorLUT;

    // Reuse ImageData buffer to avoid GC pressure (allocated once per size)
    if (!this._liveImageData || this._liveImageW !== w || this._liveImageH !== h) {
      this._liveImageData = this.ctx.createImageData(w, h);
      this._liveImageW = w;
      this._liveImageH = h;
    }
    const imgData = this._liveImageData;
    const pixels = imgData.data;
    const dbRange = this.dynamicRangeDB;

    for (let x = 0; x < w; x++) {
      const colIdx = totalCols - w + x;
      const mag = (colIdx >= 0 && colIdx < totalCols) ? this._liveColCache[colIdx % w] : null;

      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;

        if (!mag) {
          pixels[idx] = 0;
          pixels[idx + 1] = 0;
          pixels[idx + 2] = 0;
          pixels[idx + 3] = 255;
          continue;
        }

        const bin0 = yBins[y];
        const frac = yFracs[y];
        let raw0 = mag[bin0];
        if (raw0 === undefined || !isFinite(raw0)) raw0 = -120;
        let raw;
        if (frac > 0 && bin0 + 1 <= maxBinCached) {
          let raw1 = mag[bin0 + 1];
          if (raw1 === undefined || !isFinite(raw1)) raw1 = -120;
          raw = raw0 + frac * (raw1 - raw0);
        } else {
          raw = raw0;
        }

        const db = raw + this.gainDB;
        const norm = Math.max(0, Math.min(255, Math.round(((db - floor) / dbRange) * 255)));
        const lutIdx = norm * 4;

        pixels[idx]     = lut[lutIdx];
        pixels[idx + 1] = lut[lutIdx + 1];
        pixels[idx + 2] = lut[lutIdx + 2];
        pixels[idx + 3] = 255;
      }
    }

    // Store as _liveImage for draw() to use
    this._liveImage = imgData;
  }

  stopLive() {
    if (this._liveRAF) {
      cancelAnimationFrame(this._liveRAF);
      this._liveRAF = null;
    }
    // Close any open recording region
    const active = this._liveRecordRegions.find(r => r.endSample === null);
    if (active && this._liveCapture) active.endSample = this._liveCapture.totalSamples;
    this._liveCapture = null;
    this._liveColCache = null;
    this._liveImage = null;
    this._liveImageData = null;
    this._liveColorLUT = null;
  }

  get isLive() {
    return this._liveCapture !== null && this._liveCapture.isCapturing;
  }
}
