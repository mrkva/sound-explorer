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

    // FFT settings
    this.fftSize = options.fftSize || 2048;
    this.hopSize = options.hopSize || null; // auto-calculated
    this.minFreq = options.minFreq || 0;
    this.maxFreq = options.maxFreq || 22050;
    this.logFrequency = options.logFrequency || false; // Log frequency scale

    // Gain/contrast controls
    this.gainDB = options.gainDB || 0;          // Boost in dB (positive = amplify faint sounds)
    this.dynamicRangeDB = options.dynamicRangeDB || 90;

    // Color preset
    this.colorPreset = options.colorPreset || 'viridis';

    // View state
    this.viewStart = 0;
    this.viewEnd = 10;
    this.totalDuration = 0;

    // Session reference (set by app)
    this.session = null;

    // Tile cache: key = "startSample-endSample-fftSize" -> { frames, freqBins, numFrames, hopSize }
    this.tileCache = new Map();
    this.maxCacheSize = 200;

    // Last computed FFT data (kept for instant gain/range re-rendering)
    this._lastFFTData = null;

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

    // Hann window (pre-computed)
    this._window = null;

    // Rendered spectrogram image (ImageData or ImageBitmap)
    this._spectBitmap = null;

    // Last known playback time (so draw() can show cursor without explicit arg)
    this._lastPlaybackTime = null;

    // Web Worker pool for parallel FFT
    this._workers = [];
    this._workerReady = [];
    this._initWorkers();

    // Render worker for off-main-thread pixel rendering
    this._renderWorker = null;
    this._initRenderWorker();

    this._setupInteraction();
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
    this.tileCache.clear();
    this._window = null;
  }

  // Progress callback: (phase, percent) => void
  // phase: 'reading' | 'computing' | 'rendering'
  onProgress = null;

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

      // Check cache
      const cacheKey = `${startSample}-${endSample}-${this.fftSize}-${targetFrames}`;
      let spectrogramData = this.tileCache.get(cacheKey);

      if (!spectrogramData) {
        this._reportProgress('reading', 0);
        // Yield so the overlay can appear before heavy work starts
        await new Promise(r => setTimeout(r, 0));

        if (needsSubsampling) {
          spectrogramData = await this._computeSubsampled(
            startSample, endSample, targetFrames
          );
        } else {
          // FULL MODE: Read all samples and compute FFT on workers
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

        // Cache it
        if (this.tileCache.size >= this.maxCacheSize) {
          const keys = [...this.tileCache.keys()];
          for (let i = 0; i < 50 && i < keys.length; i++) {
            this.tileCache.delete(keys[i]);
          }
        }
        this.tileCache.set(cacheKey, spectrogramData);
      }

      this._lastFFTData = spectrogramData;
      this._reportProgress('rendering', 0);
      await this._renderSpectrogram(spectrogramData);
      this._reportProgress('done', 100);
      this.draw();
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

    this._ensureWindow(N);

    const frames = new Array(targetFrames);
    const session = this.session;
    let framesComputed = 0;

    for (const file of session.files) {
      const fileStartSample = file.sampleStart;
      const fileEndSample = file.sampleStart + file.samples;

      // Find frames that start within this file (with room for a full FFT window)
      const firstFrame = Math.max(0, Math.ceil((fileStartSample - startSample) / step));
      const lastFrame = Math.min(targetFrames - 1,
        Math.floor((fileEndSample - startSample - N) / step));

      if (firstFrame > lastFrame || lastFrame < 0) continue;

      const readStartSample = startSample + firstFrame * step;
      const readEndSample = Math.min(startSample + lastFrame * step + N, fileEndSample);
      const offsetInFile = Math.max(0, readStartSample - fileStartSample);
      const samplesToRead = readEndSample - (fileStartSample + offsetInFile);

      if (samplesToRead <= 0) continue;

      const maxSamplesPerChunk = 1024 * 1024;
      let chunkData = null;
      let chunkOffset = 0;

      // Collect all frame data from this file first, then batch-FFT via workers
      const fileFrameData = []; // [{index, data}]

      for (let i = firstFrame; i <= lastFrame; i++) {
        const frameSampleInRange = (startSample + i * step) - readStartSample;

        // Check if we need to read a new chunk
        if (!chunkData ||
            frameSampleInRange < chunkOffset ||
            frameSampleInRange + N > chunkOffset + (chunkData ? chunkData.length : 0)) {
          chunkOffset = Math.max(0, frameSampleInRange - N);
          const chunkSamples = Math.min(maxSamplesPerChunk, samplesToRead - chunkOffset);
          if (chunkSamples <= 0) break;

          const byteOff = (offsetInFile + chunkOffset) * session.blockAlign;
          const byteLen = chunkSamples * session.blockAlign;

          const rawBytes = await window.electronAPI.readPcmChunk(
            file.filePath, file.dataOffset, byteOff, byteLen
          );
          chunkData = new Float32Array(Math.floor(rawBytes.byteLength / session.blockAlign));
          this._decodePCMToMono(
            new DataView(rawBytes), session.bitsPerSample, session.channels,
            chunkData, 0, chunkData.length
          );
        }

        const localOffset = frameSampleInRange - chunkOffset;
        if (localOffset < 0 || !chunkData || localOffset + N > chunkData.length) {
          continue;
        }
        // Copy the frame data (will be sent to worker)
        const frameData = new Float32Array(N);
        for (let j = 0; j < N; j++) {
          frameData[j] = chunkData[localOffset + j] || 0;
        }
        fileFrameData.push({ index: i, data: frameData });
      }

      // Batch-FFT via worker pool (parallel across CPU cores)
      if (fileFrameData.length > 0) {
        const batchSize = 200; // Process in batches to report progress
        for (let b = 0; b < fileFrameData.length; b += batchSize) {
          const batch = fileFrameData.slice(b, b + batchSize);
          const rawFrames = batch.map(f => f.data);
          const magnitudes = await this._computeFFTBatch(rawFrames);

          for (let k = 0; k < batch.length; k++) {
            frames[batch[k].index] = magnitudes[k];
          }
          framesComputed += batch.length;
          this._reportProgress('computing', Math.round((framesComputed / targetFrames) * 100));
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }

    // Fill any gaps (frames that fell between files) with silence
    for (let i = 0; i < targetFrames; i++) {
      if (!frames[i]) {
        frames[i] = new Float32Array(freqBins);
        frames[i].fill(-120); // silence
      }
    }

    return { frames, freqBins, numFrames: targetFrames, hopSize: step };
  }

  _reportProgress(phase, percent) {
    if (this.onProgress) this.onProgress(phase, percent);
  }

  // ── Web Worker Pool ─────────────────────────────────────────────────────

  _initWorkers() {
    try {
      for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker('src/fft-worker.js');
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
      this._renderWorker = new Worker('src/render-worker.js');
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
    if (!this._window || this._window.length !== N) {
      this._window = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      }
    }
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
  async _readPCMRange(startSample, numSamples) {
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
        this._decodePCMToMono(
          new DataView(rawBytes), session.bitsPerSample, session.channels,
          mono, c.outputOffset, actualSamples
        );
      }

      completed += batch.length;
      this._reportProgress('reading', Math.round((completed / chunks.length) * 100));
    }

    return mono;
  }

  /**
   * Decode raw PCM bytes to mono float samples.
   * Handles 16-bit, 24-bit, 32-bit integer, and 32-bit float.
   */
  _decodePCMToMono(view, bitsPerSample, channels, output, outputOffset, numSamples) {
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = channels * bytesPerSample;
    const scale = 1 / channels;
    const isFloat = this.session && this.session.format === 3;

    for (let i = 0; i < numSamples; i++) {
      const frameOffset = i * blockAlign;
      if (frameOffset + blockAlign > view.byteLength) break;

      let monoValue = 0;
      for (let ch = 0; ch < channels; ch++) {
        const sampleOffset = frameOffset + ch * bytesPerSample;

        let value;
        if (bitsPerSample === 16) {
          value = view.getInt16(sampleOffset, true) / 32768;
        } else if (bitsPerSample === 24) {
          const b0 = view.getUint8(sampleOffset);
          const b1 = view.getUint8(sampleOffset + 1);
          const b2 = view.getInt8(sampleOffset + 2); // signed for MSB
          value = (b2 * 65536 + b1 * 256 + b0) / 8388608;
        } else if (bitsPerSample === 32 && isFloat) {
          // IEEE 754 float, already in -1.0 to +1.0 range
          value = view.getFloat32(sampleOffset, true);
        } else if (bitsPerSample === 32) {
          // 32-bit integer
          value = view.getInt32(sampleOffset, true) / 2147483648;
        } else {
          value = 0;
        }

        monoValue += value * scale;
      }

      output[outputOffset + i] = monoValue;
    }
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
      const bitmap = await new Promise((resolve) => {
        this._renderWorker.onmessage = (e) => resolve(e.data.bitmap);
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
   * Draw the spectrogram + axes + cursor to the visible canvas.
   */
  draw(playbackTime = null) {
    if (playbackTime !== null) {
      this._lastPlaybackTime = playbackTime;
    }
    const cursorTime = this._lastPlaybackTime;
    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#0f0f1a';
    this.ctx.fillRect(0, 0, width, height);

    if (this._spectBitmap) {
      this.ctx.drawImage(this._spectBitmap, 50, 0);
    } else if (this._spectImage) {
      this.ctx.putImageData(this._spectImage, 50, 0);
    }

    // Frequency axis
    this._drawFrequencyAxis(height);

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
        this.ctx.fillStyle = 'rgba(79, 195, 247, 0.2)';
        this.ctx.fillRect(x1, 0, x2 - x1, height - 40);
        // Selection edges
        this.ctx.strokeStyle = 'rgba(79, 195, 247, 0.7)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([3, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(x1, 0); this.ctx.lineTo(x1, height - 40);
        this.ctx.moveTo(x2, 0); this.ctx.lineTo(x2, height - 40);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
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
  }

  _drawFileBoundaries(canvasWidth, canvasHeight) {
    if (!this.session || this.session.files.length <= 1) return;

    const spectWidth = canvasWidth - 60;
    const spectHeight = canvasHeight - 40;
    const viewDuration = this.viewEnd - this.viewStart;

    this.ctx.strokeStyle = 'rgba(255, 255, 100, 0.3)';
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
        this.ctx.fillStyle = 'rgba(255, 255, 100, 0.5)';
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
      this.ctx.fillStyle = 'rgba(255, 152, 0, 0.6)';
      this.ctx.fillRect(x1, axisY - 4, barW, 4);

      // Draw label if there's room
      if (barW > 20) {
        this.ctx.fillStyle = 'rgba(255, 152, 0, 0.85)';
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
      this.ctx.fillStyle = '#fff';
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
    this.ctx.fillStyle = '#0f0f1a';
    this.ctx.fillRect(0, 0, 50, canvasHeight);
    this.ctx.fillStyle = '#aaaacc';
    this.ctx.font = '9px monospace';
    this.ctx.textAlign = 'right';
    this.ctx.strokeStyle = 'rgba(170, 170, 204, 0.3)';
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
          this.ctx.fillStyle = '#aaaacc';
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
          this.ctx.fillStyle = '#aaaacc';
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
    this.ctx.fillStyle = '#0f0f1a';
    this.ctx.fillRect(0, axisY, canvasWidth, 40);
    this.ctx.fillStyle = '#aaaacc';
    this.ctx.font = '11px monospace';
    this.ctx.textAlign = 'center';

    const viewDuration = this.viewEnd - this.viewStart;
    const spectWidth = canvasWidth - 60;

    const targetTicks = 10;
    const rawInterval = viewDuration / targetTicks;
    const niceIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const interval = niceIntervals.find(i => i >= rawInterval) || 3600;

    const startTick = Math.ceil(this.viewStart / interval) * interval;
    const hasWallClock = this.session && this.session.sessionStartTime !== null;

    for (let t = startTick; t <= this.viewEnd; t += interval) {
      const x = 50 + ((t - this.viewStart) / viewDuration) * spectWidth;

      this.ctx.strokeStyle = '#333355';
      this.ctx.beginPath();
      this.ctx.moveTo(x, axisY);
      this.ctx.lineTo(x, axisY + 5);
      this.ctx.stroke();

      // Show wall-clock time if available, otherwise file position
      if (hasWallClock) {
        const wallSec = this.session.toWallClock(t);
        if (wallSec !== null) {
          this.ctx.fillStyle = '#66ff88';
          this.ctx.fillText(this._formatWallTime(wallSec), x, axisY + 18);
        }
        // Also show file position below
        this.ctx.fillStyle = '#777799';
        this.ctx.font = '9px monospace';
        this.ctx.fillText(this._formatDuration(t), x, axisY + 32);
        this.ctx.font = '11px monospace';
      } else {
        this.ctx.fillStyle = '#aaaacc';
        this.ctx.fillText(this._formatDuration(t), x, axisY + 20);
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
        [0.0, 68, 1, 84], [0.13, 72, 36, 117], [0.25, 65, 68, 135],
        [0.38, 53, 95, 141], [0.50, 42, 120, 142], [0.63, 33, 145, 140],
        [0.75, 34, 168, 132], [0.82, 68, 191, 112], [0.88, 122, 209, 81],
        [0.94, 189, 223, 38], [1.0, 253, 231, 37]
      ],
      magma: [
        [0.0, 0, 0, 4], [0.13, 28, 16, 68], [0.25, 79, 18, 123],
        [0.38, 129, 37, 129], [0.50, 181, 54, 122], [0.63, 229, 89, 100],
        [0.75, 251, 136, 97], [0.85, 254, 188, 118], [0.94, 254, 228, 152],
        [1.0, 252, 253, 191]
      ],
      inferno: [
        [0.0, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109],
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
    this.viewStart = Math.max(0, start);
    this.viewEnd = Math.min(this.totalDuration, end);
    this.draw(); // Always redraw immediately (axes, cursor, selection)
    if (this.onViewChange) this.onViewChange(this.viewStart, this.viewEnd);
  }

  zoom(centerTime, factor) {
    const currentDuration = this.viewEnd - this.viewStart;
    const newDuration = Math.max(0.5, Math.min(this.totalDuration, currentDuration * factor));
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
    if (this._lastFFTData) {
      await this._renderSpectrogram(this._lastFFTData);
      this.draw();
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
      // Get cursor position relative to canvas for zoom center
      const rect = this.canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const time = this.canvasXToTime(canvasX);

      // Trackpad pinch-to-zoom sends ctrlKey+wheel with fine deltaY
      // Regular scroll wheel sends larger discrete deltaY
      let factor;
      if (e.ctrlKey) {
        // Pinch gesture: deltaY is small and continuous
        factor = 1 + e.deltaY * 0.02;
      } else {
        factor = e.deltaY > 0 ? 1.3 : 1 / 1.3;
      }
      this.zoom(time, factor);
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

      // Report cursor position (time + frequency)
      if (this.onCursorMove) {
        const rect = this.canvas.getBoundingClientRect();
        const canvasX = e.clientX - rect.left;
        const canvasY = e.clientY - rect.top;
        const time = this.canvasXToTime(canvasX);
        const freq = this.canvasYToFreq(canvasY);
        this.onCursorMove(time, freq);
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
      this.canvas.style.cursor = 'crosshair';
      if (this.onCursorMove) this.onCursorMove(null, null);
    });
  }
}
