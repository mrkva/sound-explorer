/**
 * On-demand spectrogram renderer.
 *
 * Instead of computing the entire spectrogram upfront, this reads PCM chunks
 * from the session files and computes FFT only for the visible time range.
 * Computed tiles are cached for fast scrolling.
 *
 * Supports adjustable gain/contrast for seeing faint sounds.
 */

export class SpectrogramRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // FFT settings
    this.fftSize = options.fftSize || 2048;
    this.hopSize = options.hopSize || null; // auto-calculated
    this.minFreq = options.minFreq || 0;
    this.maxFreq = options.maxFreq || 22050;

    // Gain/contrast controls
    this.gainDB = options.gainDB || 0;          // Boost in dB (positive = amplify faint sounds)
    this.dynamicRangeDB = options.dynamicRangeDB || 90;
    this.floorDB = options.floorDB || -90;       // Noise floor

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

    // Hann window (pre-computed)
    this._window = null;

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
      const targetFrames = Math.min(canvasWidth * 2, 4000);

      // The hop size determines how many samples per FFT frame
      const hopSize = this.hopSize || Math.max(
        this.fftSize / 4,
        Math.floor((viewDuration * this.session.sampleRate) / targetFrames)
      );

      // Total samples we'd need to read for this view
      const startSample = Math.floor(this.viewStart * this.session.sampleRate);
      const endSample = Math.ceil(this.viewEnd * this.session.sampleRate);
      const totalViewSamples = endSample - startSample;

      // How many samples we actually need: targetFrames * hopSize + fftSize
      const samplesNeeded = targetFrames * hopSize + this.fftSize;

      // If we'd need to read way more samples than we need for the target
      // frames, we should subsample: read small windows spaced apart
      const needsSubsampling = totalViewSamples > samplesNeeded * 1.5;

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
          // FULL MODE: Read all samples and compute FFT continuously
          const pcmData = await this._readPCMRange(startSample, totalViewSamples);
          if (!pcmData) {
            this._computing = false;
            this._reportProgress('done', 100);
            return;
          }
          this._reportProgress('computing', 0);
          await new Promise(r => setTimeout(r, 0));
          spectrogramData = this._computeFFT(pcmData, hopSize);
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
      this._renderSpectrogram(spectrogramData);
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
    const step = Math.floor(totalSpan / targetFrames);

    if (!this._window || this._window.length !== N) {
      this._window = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      }
    }

    const frames = new Array(targetFrames);
    const session = this.session;

    // Process file by file - one IPC read per file per chunk
    // For each file, figure out which frames fall within it
    let framesComputed = 0;

    for (const file of session.files) {
      const fileStartSample = file.sampleStart;
      const fileEndSample = file.sampleStart + file.samples;

      // Find frames that start within this file
      const firstFrame = Math.max(0, Math.ceil((fileStartSample - startSample) / step));
      const lastFrame = Math.min(targetFrames - 1,
        Math.floor((fileEndSample - startSample - N) / step));

      if (firstFrame > lastFrame) continue;

      // Read the needed range from this file in one big read
      // From the first frame's start to the last frame's end
      const readStartSample = startSample + firstFrame * step;
      const readEndSample = Math.min(
        startSample + lastFrame * step + N,
        fileEndSample
      );
      const offsetInFile = readStartSample - fileStartSample;
      const samplesToRead = readEndSample - readStartSample;

      // Read in chunks of ~4MB of float data (~1M samples)
      const maxSamplesPerChunk = 1024 * 1024;
      let chunkStartSample = 0;
      let chunkData = null;
      let chunkOffset = 0; // sample offset within the read range that chunkData covers

      for (let i = firstFrame; i <= lastFrame; i++) {
        const frameSampleInRange = (startSample + i * step) - readStartSample;

        // Check if we need to read a new chunk
        if (!chunkData ||
            frameSampleInRange < chunkOffset ||
            frameSampleInRange + N > chunkOffset + (chunkData ? chunkData.length : 0)) {
          // Read a new chunk centered around this frame
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

        // Extract the window from chunk
        const localOffset = frameSampleInRange - chunkOffset;
        const windowed = new Float32Array(N);
        for (let j = 0; j < N; j++) {
          windowed[j] = (chunkData[localOffset + j] || 0) * this._window[j];
        }

        // FFT
        const spectrum = this._fft(windowed);
        const magnitudes = new Float32Array(freqBins);
        for (let j = 0; j < freqBins; j++) {
          const re = spectrum[2 * j];
          const im = spectrum[2 * j + 1];
          magnitudes[j] = 20 * Math.log10(Math.max(Math.sqrt(re * re + im * im), 1e-10));
        }
        frames[i] = magnitudes;
        framesComputed++;

        // Report progress & yield periodically
        if (framesComputed % 100 === 0) {
          this._reportProgress('computing', Math.round((framesComputed / targetFrames) * 100));
          await new Promise(r => setTimeout(r, 0));
        }
      }
    }

    // Fill any gaps (frames that fell between files)
    for (let i = 0; i < targetFrames; i++) {
      if (!frames[i]) frames[i] = new Float32Array(freqBins);
    }

    return { frames, freqBins, numFrames: targetFrames, hopSize: step };
  }

  _reportProgress(phase, percent) {
    if (this.onProgress) this.onProgress(phase, percent);
  }

  /**
   * Read PCM samples from session files for the given sample range.
   * Handles reading across multiple files.
   */
  async _readPCMRange(startSample, numSamples) {
    const session = this.session;
    const blockAlign = session.blockAlign;
    const mono = new Float32Array(numSamples);
    let samplesRead = 0;

    for (const file of session.files) {
      if (samplesRead >= numSamples) break;

      const fileEndSample = file.sampleStart + file.samples;
      const readStart = startSample + samplesRead;

      // Check if this file overlaps our range
      if (readStart >= fileEndSample) continue;
      if (readStart + (numSamples - samplesRead) <= file.sampleStart) continue;

      // Calculate the overlap
      const fileOffset = Math.max(0, readStart - file.sampleStart);
      const remainingInFile = file.samples - fileOffset;
      const toRead = Math.min(numSamples - samplesRead, remainingInFile);

      if (toRead <= 0) continue;

      // Read raw bytes
      const byteOffset = fileOffset * blockAlign;
      const byteLength = toRead * blockAlign;

      // Read in sub-chunks to avoid huge IPC transfers (max 8MB per chunk)
      const maxChunkBytes = 8 * 1024 * 1024;
      let bytesReadSoFar = 0;

      while (bytesReadSoFar < byteLength) {
        const chunkLen = Math.min(maxChunkBytes, byteLength - bytesReadSoFar);
        const rawBytes = await window.electronAPI.readPcmChunk(
          file.filePath, file.dataOffset, byteOffset + bytesReadSoFar, chunkLen
        );

        const samplesInChunk = Math.floor(rawBytes.byteLength / blockAlign);
        this._decodePCMToMono(
          new DataView(rawBytes), session.bitsPerSample, session.channels,
          mono, samplesRead + bytesReadSoFar / blockAlign, samplesInChunk
        );

        bytesReadSoFar += chunkLen;

        // Report read progress
        const totalBytesNeeded = numSamples * blockAlign;
        const totalBytesRead = (samplesRead * blockAlign) + bytesReadSoFar;
        this._reportProgress('reading', Math.round((totalBytesRead / totalBytesNeeded) * 100));
      }

      samplesRead += toRead;
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

  /**
   * Compute FFT frames from mono PCM data.
   */
  _computeFFT(monoData, hopSize) {
    const N = this.fftSize;
    const numFrames = Math.max(1, Math.floor((monoData.length - N) / hopSize) + 1);
    const freqBins = N / 2;

    // Ensure Hann window is ready
    if (!this._window || this._window.length !== N) {
      this._window = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      }
    }

    const frames = new Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      const start = i * hopSize;
      const frame = new Float32Array(N);
      for (let j = 0; j < N; j++) {
        frame[j] = (monoData[start + j] || 0) * this._window[j];
      }

      const spectrum = this._fft(frame);
      const magnitudes = new Float32Array(freqBins);
      for (let j = 0; j < freqBins; j++) {
        const re = spectrum[2 * j];
        const im = spectrum[2 * j + 1];
        magnitudes[j] = 20 * Math.log10(Math.max(Math.sqrt(re * re + im * im), 1e-10));
      }
      frames[i] = magnitudes;
    }

    return { frames, freqBins, numFrames, hopSize };
  }

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
          curIm = curRe * wIm + curIm * wRe;
          curRe = newRe;
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
   * Render spectrogram data to the canvas.
   */
  _renderSpectrogram(data) {
    const { width, height } = this.canvas;
    const spectWidth = width - 60;
    const spectHeight = height - 40;

    if (spectWidth <= 0 || spectHeight <= 0) return;

    const { frames, freqBins, numFrames } = data;

    // Frequency range in bins
    const binRes = this.session.sampleRate / this.fftSize;
    const minBin = Math.floor(this.minFreq / binRes);
    const maxBin = Math.min(Math.ceil(this.maxFreq / binRes), freqBins);
    const visibleBins = maxBin - minBin;

    // Create image
    const imageData = this.ctx.createImageData(spectWidth, spectHeight);
    const pixels = imageData.data;

    // Effective gain-adjusted floor and ceiling
    const ceiling = this.gainDB;
    const floor = ceiling - this.dynamicRangeDB;

    for (let x = 0; x < spectWidth; x++) {
      const frameIdx = Math.min(Math.floor(x * numFrames / spectWidth), numFrames - 1);
      const spectrum = frames[frameIdx];

      for (let y = 0; y < spectHeight; y++) {
        const bin = Math.min(
          minBin + Math.floor((spectHeight - 1 - y) * visibleBins / spectHeight),
          freqBins - 1
        );
        const db = (spectrum[bin] !== undefined ? spectrum[bin] : -120) + this.gainDB;

        const normalized = Math.max(0, Math.min(1, (db - floor) / this.dynamicRangeDB));
        const [r, g, b] = this._colorize(normalized);

        const idx = (y * spectWidth + x) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    // Store for redrawing with cursor
    this._spectImage = imageData;
    this._spectWidth = spectWidth;
    this._spectHeight = spectHeight;
  }

  /**
   * Draw the spectrogram + axes + cursor to the visible canvas.
   */
  draw(playbackTime = null) {
    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#0f0f1a';
    this.ctx.fillRect(0, 0, width, height);

    if (this._spectImage) {
      this.ctx.putImageData(this._spectImage, 50, 0);
    }

    // Frequency axis
    this._drawFrequencyAxis(height);

    // Time axis
    this._drawTimeAxis(width, height);

    // File boundaries
    this._drawFileBoundaries(width, height);

    // Playback cursor
    if (playbackTime !== null && playbackTime >= this.viewStart && playbackTime <= this.viewEnd) {
      const spectWidth = width - 60;
      const x = 50 + ((playbackTime - this.viewStart) / (this.viewEnd - this.viewStart)) * spectWidth;
      this.ctx.strokeStyle = '#ff4444';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height - 40);
      this.ctx.stroke();
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

  _drawFrequencyAxis(canvasHeight) {
    this.ctx.fillStyle = '#0f0f1a';
    this.ctx.fillRect(0, 0, 50, canvasHeight);
    this.ctx.fillStyle = '#aaaacc';
    this.ctx.font = '10px monospace';
    this.ctx.textAlign = 'right';

    const spectHeight = canvasHeight - 40;
    const numLabels = 8;
    for (let i = 0; i <= numLabels; i++) {
      const freq = this.minFreq + (this.maxFreq - this.minFreq) * (1 - i / numLabels);
      const y = (i / numLabels) * spectHeight;
      let label = freq >= 1000 ? (freq / 1000).toFixed(1) + 'k' : Math.round(freq).toString();
      this.ctx.fillText(label, 46, y + 4);
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
   * Viridis colormap.
   */
  _colorize(value) {
    const stops = [
      [0.0, 68, 1, 84],
      [0.13, 72, 36, 117],
      [0.25, 65, 68, 135],
      [0.38, 53, 95, 141],
      [0.50, 42, 120, 142],
      [0.63, 33, 145, 140],
      [0.75, 34, 168, 132],
      [0.82, 68, 191, 112],
      [0.88, 122, 209, 81],
      [0.94, 189, 223, 38],
      [1.0, 253, 231, 37]
    ];

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
    return [253, 231, 37];
  }

  setView(start, end) {
    this.viewStart = Math.max(0, start);
    this.viewEnd = Math.min(this.totalDuration, end);
    if (this.onViewChange) this.onViewChange(this.viewStart, this.viewEnd);
  }

  zoom(centerTime, factor) {
    const currentDuration = this.viewEnd - this.viewStart;
    const newDuration = Math.max(0.5, Math.min(this.totalDuration, currentDuration * factor));
    const ratio = (centerTime - this.viewStart) / currentDuration;
    const newStart = centerTime - ratio * newDuration;
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
    // y=0 is top (maxFreq), y=spectHeight-1 is bottom (minFreq)
    const ratio = 1 - (y / spectHeight);
    return this.minFreq + ratio * (this.maxFreq - this.minFreq);
  }

  /**
   * Re-render the spectrogram image from cached FFT data (instant).
   * Use this when gain or dynamic range changes - no FFT recomputation needed.
   */
  rerender() {
    if (this._lastFFTData) {
      this._renderSpectrogram(this._lastFFTData);
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
      this.draw();
      scheduleCompute();
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isDragging = true;
        this.dragStartX = e.offsetX;
        this.dragStartViewStart = this.viewStart;
        this.canvas.style.cursor = 'grabbing';
      }
    });

    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.offsetX - this.dragStartX;
        const spectWidth = this.canvas.width - 60;
        const timeDelta = -(dx / spectWidth) * (this.viewEnd - this.viewStart);
        const duration = this.viewEnd - this.viewStart;
        const newStart = this.dragStartViewStart + timeDelta;
        this.setView(newStart, newStart + duration);
        this.draw();
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
      if (this.isDragging && Math.abs(e.offsetX - this.dragStartX) < 3) {
        const time = this.canvasXToTime(e.offsetX);
        if (this.onTimeClick && time >= 0 && time <= this.totalDuration) {
          this.onTimeClick(time);
        }
      }
      this.isDragging = false;
      this.canvas.style.cursor = 'crosshair';
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.canvas.style.cursor = 'crosshair';
      if (this.onCursorMove) this.onCursorMove(null, null);
    });
  }
}
