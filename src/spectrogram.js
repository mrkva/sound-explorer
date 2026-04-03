/**
 * High-resolution spectrogram renderer using Web Audio API + Canvas.
 *
 * Computes FFT offline for the full file, renders to a large canvas,
 * and supports zooming/scrolling.
 */

export class SpectrogramRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.fftSize = options.fftSize || 2048;
    this.hopSize = options.hopSize || 512;
    this.minFreq = options.minFreq || 0;
    this.maxFreq = options.maxFreq || 22050;
    this.colorMap = options.colorMap || 'viridis';
    this.dynamicRangeDB = options.dynamicRangeDB || 90;
    this.referenceDB = options.referenceDB || 0;

    this.spectrogramData = null;  // 2D array of magnitude values
    this.sampleRate = 44100;
    this.imageData = null;
    this.offscreenCanvas = null;

    // View state
    this.viewStart = 0;  // Start time in seconds
    this.viewEnd = 10;   // End time in seconds
    this.totalDuration = 0;

    // Interaction
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartViewStart = 0;

    this.onTimeClick = null;  // Callback: (timeInSeconds) => void
    this.onViewChange = null; // Callback: (viewStart, viewEnd) => void

    this._setupInteraction();
  }

  /**
   * Compute spectrogram from an AudioBuffer.
   */
  async compute(audioBuffer) {
    this.sampleRate = audioBuffer.sampleRate;
    this.totalDuration = audioBuffer.duration;
    this.maxFreq = Math.min(this.maxFreq, this.sampleRate / 2);

    // Mix to mono
    const monoData = this._mixToMono(audioBuffer);
    const numFrames = Math.floor((monoData.length - this.fftSize) / this.hopSize) + 1;

    // Compute FFT frames
    this.spectrogramData = new Array(numFrames);
    const frequencyBins = this.fftSize / 2;
    const window = this._hannWindow(this.fftSize);

    // Use OfflineAudioContext for FFT computation
    // Actually, compute manually for full control
    for (let i = 0; i < numFrames; i++) {
      const startSample = i * this.hopSize;
      const frame = new Float32Array(this.fftSize);
      for (let j = 0; j < this.fftSize; j++) {
        frame[j] = (monoData[startSample + j] || 0) * window[j];
      }

      const spectrum = this._fft(frame);
      this.spectrogramData[i] = new Float32Array(frequencyBins);
      for (let j = 0; j < frequencyBins; j++) {
        const re = spectrum[2 * j];
        const im = spectrum[2 * j + 1];
        const magnitude = Math.sqrt(re * re + im * im);
        // Convert to dB
        const db = 20 * Math.log10(Math.max(magnitude, 1e-10));
        this.spectrogramData[i][j] = db;
      }

      // Yield to UI every 1000 frames
      if (i % 1000 === 0 && i > 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    // Render to offscreen canvas
    this._renderOffscreen();

    // Set initial view to full duration
    this.viewStart = 0;
    this.viewEnd = this.totalDuration;
    this.draw();
  }

  _mixToMono(audioBuffer) {
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    const numChannels = audioBuffer.numberOfChannels;

    if (numChannels === 1) {
      audioBuffer.copyFromChannel(mono, 0);
    } else {
      const scale = 1 / numChannels;
      for (let ch = 0; ch < numChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          mono[i] += channelData[i] * scale;
        }
      }
    }
    return mono;
  }

  _hannWindow(size) {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (size - 1)));
    }
    return window;
  }

  /**
   * Cooley-Tukey FFT (radix-2, in-place).
   * Input: real-valued array of length N (must be power of 2).
   * Returns: Float32Array of length 2*N (interleaved real, imag).
   */
  _fft(input) {
    const N = input.length;
    const output = new Float32Array(2 * N);

    // Bit-reversal permutation
    for (let i = 0; i < N; i++) {
      const j = this._bitReverse(i, Math.log2(N));
      output[2 * j] = input[i];
      output[2 * j + 1] = 0;
    }

    // Butterfly stages
    for (let s = 1; s <= Math.log2(N); s++) {
      const m = 1 << s;
      const halfM = m >> 1;
      const wRe = Math.cos(-2 * Math.PI / m);
      const wIm = Math.sin(-2 * Math.PI / m);

      for (let k = 0; k < N; k += m) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < halfM; j++) {
          const tRe = curRe * output[2 * (k + j + halfM)] - curIm * output[2 * (k + j + halfM) + 1];
          const tIm = curRe * output[2 * (k + j + halfM) + 1] + curIm * output[2 * (k + j + halfM)];

          const uRe = output[2 * (k + j)];
          const uIm = output[2 * (k + j) + 1];

          output[2 * (k + j)] = uRe + tRe;
          output[2 * (k + j) + 1] = uIm + tIm;
          output[2 * (k + j + halfM)] = uRe - tRe;
          output[2 * (k + j + halfM) + 1] = uIm - tIm;

          const newCurRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = newCurRe;
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
   * Render full spectrogram to offscreen canvas for fast scrolling.
   */
  _renderOffscreen() {
    if (!this.spectrogramData || this.spectrogramData.length === 0) return;

    const numFrames = this.spectrogramData.length;
    const freqBins = this.spectrogramData[0].length;

    // Determine visible frequency range in bins
    const binResolution = this.sampleRate / this.fftSize;
    const minBin = Math.floor(this.minFreq / binResolution);
    const maxBin = Math.min(Math.ceil(this.maxFreq / binResolution), freqBins);
    const visibleBins = maxBin - minBin;

    // Create offscreen canvas (limit width for memory)
    const maxWidth = Math.min(numFrames, 16384);
    const height = Math.min(visibleBins, 1024);

    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = maxWidth;
    this.offscreenCanvas.height = height;
    const offCtx = this.offscreenCanvas.getContext('2d');
    const imageData = offCtx.createImageData(maxWidth, height);
    const pixels = imageData.data;

    const frameStep = Math.max(1, Math.floor(numFrames / maxWidth));

    for (let x = 0; x < maxWidth; x++) {
      const frameIdx = Math.min(Math.floor(x * numFrames / maxWidth), numFrames - 1);
      const spectrum = this.spectrogramData[frameIdx];

      for (let y = 0; y < height; y++) {
        // Flip y so low frequencies are at bottom
        const bin = minBin + Math.floor((height - 1 - y) * visibleBins / height);
        const db = spectrum[bin] || -120;

        // Normalize to 0-1 range
        const normalized = Math.max(0, Math.min(1,
          (db - (this.referenceDB - this.dynamicRangeDB)) / this.dynamicRangeDB
        ));

        const [r, g, b] = this._colorize(normalized);
        const idx = (y * maxWidth + x) * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }

    offCtx.putImageData(imageData, 0, 0);
  }

  /**
   * Viridis-inspired colormap: dark purple -> blue -> teal -> green -> yellow.
   */
  _colorize(value) {
    if (this.colorMap === 'grayscale') {
      const v = Math.floor(value * 255);
      return [v, v, v];
    }

    // Viridis approximation
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

  /**
   * Draw the visible portion of the spectrogram to the display canvas.
   */
  draw(playbackTime = null) {
    if (!this.offscreenCanvas) return;

    const { width, height } = this.canvas;
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, width, height);

    // Map view range to offscreen canvas coordinates
    const srcX = (this.viewStart / this.totalDuration) * this.offscreenCanvas.width;
    const srcW = ((this.viewEnd - this.viewStart) / this.totalDuration) * this.offscreenCanvas.width;

    if (srcW > 0) {
      this.ctx.drawImage(
        this.offscreenCanvas,
        srcX, 0, srcW, this.offscreenCanvas.height,
        50, 0, width - 60, height - 40  // Leave space for axes
      );
    }

    // Draw frequency axis (left)
    this._drawFrequencyAxis(height);

    // Draw time axis (bottom)
    this._drawTimeAxis(width, height);

    // Draw playback cursor
    if (playbackTime !== null && playbackTime >= this.viewStart && playbackTime <= this.viewEnd) {
      const x = 50 + ((playbackTime - this.viewStart) / (this.viewEnd - this.viewStart)) * (width - 60);
      this.ctx.strokeStyle = '#ff4444';
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, height - 40);
      this.ctx.stroke();
    }
  }

  _drawFrequencyAxis(canvasHeight) {
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, 50, canvasHeight);
    this.ctx.fillStyle = '#aaaacc';
    this.ctx.font = '10px monospace';
    this.ctx.textAlign = 'right';

    const spectrogramHeight = canvasHeight - 40;
    const numLabels = 8;
    for (let i = 0; i <= numLabels; i++) {
      const freq = this.minFreq + (this.maxFreq - this.minFreq) * (1 - i / numLabels);
      const y = (i / numLabels) * spectrogramHeight;
      let label;
      if (freq >= 1000) {
        label = (freq / 1000).toFixed(1) + 'k';
      } else {
        label = Math.round(freq).toString();
      }
      this.ctx.fillText(label, 46, y + 4);
    }
  }

  _drawTimeAxis(canvasWidth, canvasHeight) {
    const axisY = canvasHeight - 40;
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, axisY, canvasWidth, 40);
    this.ctx.fillStyle = '#aaaacc';
    this.ctx.font = '11px monospace';
    this.ctx.textAlign = 'center';

    const viewDuration = this.viewEnd - this.viewStart;
    const spectrogramWidth = canvasWidth - 60;

    // Choose nice tick interval
    const targetTicks = 10;
    const rawInterval = viewDuration / targetTicks;
    const niceIntervals = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    const interval = niceIntervals.find(i => i >= rawInterval) || 3600;

    const startTick = Math.ceil(this.viewStart / interval) * interval;
    for (let t = startTick; t <= this.viewEnd; t += interval) {
      const x = 50 + ((t - this.viewStart) / viewDuration) * spectrogramWidth;

      // Tick mark
      this.ctx.strokeStyle = '#555577';
      this.ctx.beginPath();
      this.ctx.moveTo(x, axisY);
      this.ctx.lineTo(x, axisY + 5);
      this.ctx.stroke();

      // Time label
      this.ctx.fillText(this._formatAxisTime(t), x, axisY + 20);
    }
  }

  _formatAxisTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);

    if (seconds < 60) {
      return `${s}.${ms}s`;
    } else if (seconds < 3600) {
      return `${m}:${s.toString().padStart(2, '0')}`;
    } else {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Set visible time range.
   */
  setView(start, end) {
    this.viewStart = Math.max(0, start);
    this.viewEnd = Math.min(this.totalDuration, end);
    if (this.onViewChange) {
      this.onViewChange(this.viewStart, this.viewEnd);
    }
    this.draw();
  }

  /**
   * Zoom centered on a time position.
   */
  zoom(centerTime, factor) {
    const currentDuration = this.viewEnd - this.viewStart;
    const newDuration = Math.max(0.1, Math.min(this.totalDuration, currentDuration * factor));
    const ratio = (centerTime - this.viewStart) / currentDuration;
    const newStart = centerTime - ratio * newDuration;
    this.setView(newStart, newStart + newDuration);
  }

  /**
   * Convert canvas x-coordinate to time in seconds.
   */
  canvasXToTime(x) {
    const spectrogramWidth = this.canvas.width - 60;
    const ratio = (x - 50) / spectrogramWidth;
    return this.viewStart + ratio * (this.viewEnd - this.viewStart);
  }

  _setupInteraction() {
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const time = this.canvasXToTime(e.offsetX);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      this.zoom(time, factor);
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
        const spectrogramWidth = this.canvas.width - 60;
        const timeDelta = -(dx / spectrogramWidth) * (this.viewEnd - this.viewStart);
        const newStart = this.dragStartViewStart + timeDelta;
        const duration = this.viewEnd - this.viewStart;
        this.setView(newStart, newStart + duration);
      }
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (this.isDragging && Math.abs(e.offsetX - this.dragStartX) < 3) {
        // It was a click, not a drag
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
    });
  }
}
