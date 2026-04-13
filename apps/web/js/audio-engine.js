/**
 * Audio engine — true tape-speed playback.
 *
 * Instead of using audioElement.playbackRate (which glitches at low rates),
 * we re-encode the WAV blob with a modified sample rate in the header.
 * Playing a 384kHz file at 0.125x = writing all samples with a 48kHz header.
 * The browser always plays at rate=1, so no glitches.
 *
 * For speedup (rate > 1), we use playbackRate since browsers handle that fine.
 */

import { WavParser } from './wav-parser.js';

export class AudioEngine {
  constructor() {
    this.audio = new Audio();
    this.audio.preservesPitch = false;
    this.audio.crossOrigin = 'anonymous';

    this.audioCtx = null;
    this.gainNode = null;
    this.analyser = null;
    this.sourceNode = null;
    this._sourceConnected = false;

    this.wavInfo = null;
    this.blobUrl = null;
    this._currentRate = 1;
    // The duration of the blob in seconds (may differ from original due to sample rate trick)
    this._blobDuration = 0;
    // Ratio to convert blob time <-> original file time
    this._timeScale = 1;

    this.isPlaying = false;
    this.playbackRate = 1;
    this.gainDb = 0;

    // Loop (in original file seconds)
    this.loopStart = null;
    this.loopEnd = null;
    this._loopRAF = null;

    // Callbacks
    this.onTimeUpdate = null;
    this.onEnded = null;
    this.onLoadingSpeed = null;

    this._setupAudioListeners();
  }

  _setupAudioListeners() {
    this.audio.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this._loopRAF) cancelAnimationFrame(this._loopRAF);
      if (this.onEnded) this.onEnded();
    });
  }

  _initAudioContext() {
    if (this.audioCtx) return;
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.audioCtx.createGain();

    // Main analyser for backward compat
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512; // ~10ms at 48kHz — catches transients
    this._vuBuffer = new Float32Array(this.analyser.fftSize);
    this._vuResult = { peak: -100, rms: -100 };

    // Per-channel analysers (set up when file is loaded and channel count is known)
    this._channelAnalysers = [];
    this._channelBuffers = [];
    this._channelSplitter = null;

    // IEC 60268-10 Type II ballistic state per channel
    // Smoothed values are updated by getChannelVUMeters() / getVUMeter()
    this._meterState = []; // [{smoothPeak, smoothRms, lastTime}]
    this._meterLastTime = 0;

    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);

    // Spectrum analyser — higher resolution for frequency display
    this.spectrumAnalyser = this.audioCtx.createAnalyser();
    this.spectrumAnalyser.fftSize = 8192;
    this.spectrumAnalyser.smoothingTimeConstant = 0.7;
    this._spectrumBuffer = new Float32Array(this.spectrumAnalyser.frequencyBinCount);
    this.gainNode.connect(this.spectrumAnalyser);
  }

  /**
   * Apply IEC 60268-10 Type II ballistic smoothing to a raw dB value.
   * Attack: 10ms integration (fast but not instant — smooths per-block jitter)
   * Decay: 8.7 dB/s (20 dB in 2.3s — standard fall-back rate)
   */
  _applyBallistic(current, target, dt) {
    if (target > current) {
      // Attack: exponential rise with 10ms time constant
      const coeff = 1 - Math.exp(-dt / 0.010);
      return current + (target - current) * coeff;
    } else {
      // Decay: linear fall at 8.7 dB/s
      const decayed = current - 8.7 * dt;
      return Math.max(decayed, target);
    }
  }

  _setupChannelAnalysers(numChannels) {
    // Clean up previous splitter
    if (this._channelSplitter) {
      this._channelSplitter.disconnect();
    }
    this._channelAnalysers = [];
    this._channelBuffers = [];
    this._meterState = [];

    if (numChannels <= 1) return;

    this._channelSplitter = this.audioCtx.createChannelSplitter(numChannels);
    this.gainNode.connect(this._channelSplitter);

    for (let i = 0; i < numChannels; i++) {
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 512;
      this._channelSplitter.connect(analyser, i);
      this._channelAnalysers.push(analyser);
      this._channelBuffers.push(new Float32Array(analyser.fftSize));
    }
  }

  _connectSource() {
    if (this._sourceConnected) return;
    this._initAudioContext();
    this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);
    this.sourceNode.connect(this.gainNode);
    this._sourceConnected = true;
  }

  async loadFile(wavInfo) {
    this.wavInfo = wavInfo;
    this.stop();
    this._currentRate = -1; // force rebuild
    this.playbackRate = 1;  // reset speed to native on new file
    await this.setPlaybackRate(this.playbackRate);

    // Pre-warm the AudioContext so first play() doesn't need to initialize it.
    this._initAudioContext();
    this._setupChannelAnalysers(wavInfo.channels);
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
  }

  /**
   * Build a playback blob for the given speed.
   *
   * Strategy:
   * - Compute effectiveSR = originalSR * rate (what the audio should "sound like")
   * - If effectiveSR <= 48kHz: include all samples, write header with SR = effectiveSR
   *   Browser plays at rate=1 → audio plays slower, lower pitch = tape speed
   * - If effectiveSR > 48kHz: decimate by ceil(effectiveSR/48000),
   *   write header with SR = effectiveSR/decimationFactor, browser plays at rate=1
   *   IMPORTANT: apply anti-aliasing low-pass filter before decimation to prevent
   *   ultrasonic content from aliasing into the audible range
   * - For rate > 1 on low-SR files where effectiveSR <= 48kHz:
   *   include all samples, header SR = effectiveSR, browser plays at rate=1
   */

  /**
   * Design a windowed-sinc low-pass FIR filter for anti-aliasing before decimation.
   * @param {number} decimFactor - decimation factor (N)
   * @returns {Float32Array} filter kernel
   */
  _designAAFilter(decimFactor) {
    // Cutoff at 0.8 / decimFactor (relative to Nyquist) — slight rolloff margin
    const fc = 0.8 / decimFactor;
    // Filter length: longer for higher decimation factors, but cap for performance
    const halfLen = Math.min(decimFactor * 10, 128);
    const len = 2 * halfLen + 1;
    const kernel = new Float32Array(len);
    let sum = 0;

    for (let i = 0; i < len; i++) {
      const n = i - halfLen;
      // Sinc
      let sinc;
      if (n === 0) {
        sinc = 2 * Math.PI * fc;
      } else {
        sinc = Math.sin(2 * Math.PI * fc * n) / n;
      }
      // Blackman window
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1))
                     + 0.08 * Math.cos(4 * Math.PI * i / (len - 1));
      kernel[i] = sinc * w;
      sum += kernel[i];
    }

    // Normalize for unity gain at DC
    for (let i = 0; i < len; i++) kernel[i] /= sum;
    return kernel;
  }

  /**
   * Apply FIR filter to a single channel of samples and decimate.
   * @param {Float32Array} samples - input samples for one channel
   * @param {Float32Array} kernel - FIR filter kernel
   * @param {number} decimFactor - decimation factor
   * @param {Float32Array} prevTail - tail from previous chunk for overlap (kernel.length-1 samples)
   * @returns {{output: Float32Array, tail: Float32Array}}
   */
  _filterAndDecimate(samples, kernel, decimFactor, prevTail) {
    const halfLen = (kernel.length - 1) / 2;
    const totalLen = prevTail.length + samples.length;
    const outLen = Math.floor((totalLen - kernel.length + 1) / decimFactor);
    const output = new Float32Array(outLen);

    for (let i = 0; i < outLen; i++) {
      const center = i * decimFactor + halfLen;
      let acc = 0;
      for (let k = 0; k < kernel.length; k++) {
        const srcIdx = center - halfLen + k;
        let val;
        if (srcIdx < prevTail.length) {
          val = prevTail[srcIdx];
        } else {
          val = samples[srcIdx - prevTail.length];
        }
        acc += val * kernel[k];
      }
      output[i] = acc;
    }

    // Save tail for next chunk overlap
    const tailLen = kernel.length - 1;
    const newTail = new Float32Array(tailLen);
    for (let i = 0; i < tailLen; i++) {
      const srcIdx = samples.length - tailLen + i;
      if (srcIdx >= 0) {
        newTail[i] = samples[srcIdx];
      } else {
        // Still in prevTail territory
        newTail[i] = prevTail[prevTail.length + srcIdx] || 0;
      }
    }

    return { output, tail: newTail };
  }

  async _buildBlob(rate) {
    const wavInfo = this.wavInfo;
    const origSR = wavInfo.sampleRate;
    const effectiveSR = origSR * rate;

    let decimFactor, headerSR, outSamples;

    if (effectiveSR <= 48000) {
      // No decimation needed — all samples, header claims lower rate
      decimFactor = 1;
      headerSR = Math.max(8000, Math.round(effectiveSR)); // min 8kHz for browser compat
      outSamples = wavInfo.totalSamples;
    } else {
      // Decimate to get under 48kHz
      decimFactor = Math.ceil(effectiveSR / 48000);
      headerSR = Math.round(effectiveSR / decimFactor);
      outSamples = Math.floor(wavInfo.totalSamples / decimFactor);
    }

    const outChannels = wavInfo.channels;
    const outBytesPerSample = 2; // always 16-bit output
    const outBlockAlign = outChannels * outBytesPerSample;
    const outDataSize = outSamples * outBlockAlign;

    // Build header
    const headerSize = 44;
    const header = new ArrayBuffer(headerSize);
    const hv = new DataView(header);
    let o = 0;
    const ws = (s) => { for (let i = 0; i < s.length; i++) hv.setUint8(o + i, s.charCodeAt(i)); o += s.length; };

    ws('RIFF');
    hv.setUint32(o, 36 + outDataSize, true); o += 4;
    ws('WAVE');
    ws('fmt ');
    hv.setUint32(o, 16, true); o += 4;
    hv.setUint16(o, 1, true); o += 2; // PCM
    hv.setUint16(o, outChannels, true); o += 2;
    hv.setUint32(o, headerSR, true); o += 4;
    hv.setUint32(o, headerSR * outBlockAlign, true); o += 4;
    hv.setUint16(o, outBlockAlign, true); o += 2;
    hv.setUint16(o, 16, true); o += 2;
    ws('data');
    hv.setUint32(o, outDataSize, true); o += 4;

    // Design anti-aliasing filter if decimating
    let aaKernel = null;
    let channelTails = null;
    if (decimFactor > 1) {
      aaKernel = this._designAAFilter(decimFactor);
      channelTails = [];
      for (let ch = 0; ch < outChannels; ch++) {
        channelTails.push(new Float32Array(aaKernel.length - 1));
      }
    }

    // Process in chunks, yielding between each to allow incremental GC
    const chunkFrames = 4 * 1024 * 1024;
    const parts = [header];

    for (let pos = 0; pos < wavInfo.totalSamples; pos += chunkFrames) {
      const count = Math.min(chunkFrames, wavInfo.totalSamples - pos);
      const raw = await WavParser.readSamples(wavInfo, pos, count);
      // Yield to main thread so GC can collect previous chunk's garbage incrementally
      await new Promise(r => setTimeout(r, 0));
      const view = new DataView(raw);

      if (decimFactor === 1) {
        const outBuf = new ArrayBuffer(count * outBlockAlign);
        const outView = new DataView(outBuf);
        let outOff = 0;

        for (let i = 0; i < count; i++) {
          const frameOff = i * wavInfo.blockAlign;
          for (let ch = 0; ch < outChannels; ch++) {
            const sampleOff = frameOff + ch * (wavInfo.bitsPerSample / 8);
            const val = WavParser._readSample(view, sampleOff, wavInfo.format, wavInfo.bitsPerSample);
            const int16 = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
            outView.setInt16(outOff, int16, true);
            outOff += 2;
          }
        }
        parts.push(outBuf);
      } else {
        // Deinterleave channels into separate Float32Arrays
        const channelData = [];
        for (let ch = 0; ch < outChannels; ch++) {
          channelData.push(new Float32Array(count));
        }
        for (let i = 0; i < count; i++) {
          const frameOff = i * wavInfo.blockAlign;
          for (let ch = 0; ch < outChannels; ch++) {
            const sampleOff = frameOff + ch * (wavInfo.bitsPerSample / 8);
            channelData[ch][i] = WavParser._readSample(view, sampleOff, wavInfo.format, wavInfo.bitsPerSample);
          }
        }

        // Filter and decimate each channel
        const decimatedChannels = [];
        let minLen = Infinity;
        for (let ch = 0; ch < outChannels; ch++) {
          const result = this._filterAndDecimate(channelData[ch], aaKernel, decimFactor, channelTails[ch]);
          channelTails[ch] = result.tail;
          decimatedChannels.push(result.output);
          minLen = Math.min(minLen, result.output.length);
        }

        if (minLen <= 0) continue;

        // Interleave back to 16-bit PCM
        const outBuf = new ArrayBuffer(minLen * outBlockAlign);
        const outView = new DataView(outBuf);
        let outOff = 0;
        for (let i = 0; i < minLen; i++) {
          for (let ch = 0; ch < outChannels; ch++) {
            const val = decimatedChannels[ch][i];
            const int16 = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
            outView.setInt16(outOff, int16, true);
            outOff += 2;
          }
        }
        parts.push(outBuf);
      }
    }

    // Compute actual data size from parts (skip header at index 0)
    let actualDataSize = 0;
    for (let i = 1; i < parts.length; i++) {
      actualDataSize += parts[i].byteLength;
    }
    // Patch the header with the correct data size
    const actualOutSamples = actualDataSize / outBlockAlign;
    const hPatch = new DataView(header);
    hPatch.setUint32(4, 36 + actualDataSize, true);  // RIFF chunk size
    hPatch.setUint32(40, actualDataSize, true);       // data chunk size

    const blob = new Blob(parts, { type: 'audio/wav' });
    // Release references to chunk buffers so GC can collect them
    parts.length = 0;
    // Yield to let GC settle before playback
    await new Promise(r => setTimeout(r, 50));
    const url = URL.createObjectURL(blob);

    // The blob duration = actualOutSamples / headerSR
    // Original duration = totalSamples / origSR
    // timeScale = blobDuration / originalDuration
    this._blobDuration = actualOutSamples / headerSR;
    this._timeScale = this._blobDuration / (wavInfo.totalSamples / origSR);

    return url;
  }

  /**
   * Get current playback time in original file seconds.
   */
  getCurrentTime() {
    return this.audio.currentTime / this._timeScale;
  }

  /**
   * Get total duration in original file seconds.
   */
  getDuration() {
    return this.wavInfo ? this.wavInfo.totalSamples / this.wavInfo.sampleRate : 0;
  }

  async play() {
    if (!this.blobUrl) return;
    this._initAudioContext();
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }
    await this.audio.play();
    this.isPlaying = true;
    this._startLoopCheck();
    this._startTimeUpdate();
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    if (this._loopRAF) cancelAnimationFrame(this._loopRAF);
    if (this._timeRAF) cancelAnimationFrame(this._timeRAF);
  }

  stop() {
    this.audio.pause();
    this.audio.currentTime = 0;
    this.isPlaying = false;
    if (this._loopRAF) cancelAnimationFrame(this._loopRAF);
    if (this._timeRAF) cancelAnimationFrame(this._timeRAF);
  }

  async togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.play();
    }
  }

  seek(timeSec) {
    // Convert original file time to blob time
    const blobTime = timeSec * this._timeScale;
    this.audio.currentTime = Math.max(0, Math.min(blobTime, this.audio.duration || 0));
    if (this.onTimeUpdate) this.onTimeUpdate(this.getCurrentTime());
  }

  seekRelative(deltaSec) {
    this.seek(this.getCurrentTime() + deltaSec);
  }

  async setPlaybackRate(rate) {
    if (rate === this._currentRate) return;

    this.playbackRate = rate;
    const wasPlaying = this.isPlaying;
    const currentOrigTime = this.wavInfo && this._currentRate !== -1 ? this.getCurrentTime() : 0;

    if (wasPlaying) this.pause();

    if (this.onLoadingSpeed) this.onLoadingSpeed(true);

    // Revoke old blob
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
    }

    // Build new blob with baked-in speed
    this.blobUrl = await this._buildBlob(rate);
    this._currentRate = rate;

    // The audio element always plays at rate=1 now
    this.audio.playbackRate = 1;
    this.audio.src = this.blobUrl;
    this.audio.load();

    // Wait for the browser to fully buffer the blob before proceeding
    await new Promise((resolve) => {
      if (this.audio.readyState >= 4) {
        resolve();
      } else {
        this.audio.addEventListener('canplaythrough', resolve, { once: true });
      }
    });

    if (!this._sourceConnected) {
      this._connectSource();
    }
    this.setGain(this.gainDb);

    // Restore position
    if (currentOrigTime > 0) {
      this.seek(currentOrigTime);
    }

    if (this.onLoadingSpeed) this.onLoadingSpeed(false);

    if (wasPlaying) {
      this.play();
    }
  }

  setGain(db) {
    this.gainDb = db;
    if (this.gainNode) {
      this.gainNode.gain.value = Math.pow(10, db / 20);
    }
  }

  setVolume(vol) {
    this.audio.volume = Math.max(0, Math.min(1, vol));
  }

  setLoop(startSec, endSec) {
    this.loopStart = startSec;
    this.loopEnd = endSec;
  }

  clearLoop() {
    this.loopStart = null;
    this.loopEnd = null;
  }

  _startLoopCheck() {
    if (this._loopRAF) cancelAnimationFrame(this._loopRAF);
    const check = () => {
      if (!this.isPlaying) return;
      if (this.loopStart !== null && this.loopEnd !== null) {
        if (this.getCurrentTime() >= this.loopEnd) {
          this.seek(this.loopStart);
        }
      }
      this._loopRAF = requestAnimationFrame(check);
    };
    this._loopRAF = requestAnimationFrame(check);
  }

  _startTimeUpdate() {
    if (this._timeRAF) cancelAnimationFrame(this._timeRAF);
    const update = () => {
      if (!this.isPlaying) return;
      if (this.onTimeUpdate) this.onTimeUpdate(this.getCurrentTime());
      this._timeRAF = requestAnimationFrame(update);
    };
    this._timeRAF = requestAnimationFrame(update);
  }

  /**
   * Get VU meter values (raw, unsmoothed).
   * @returns {{ peak: number, rms: number }} in dB
   */
  getVUMeter() {
    if (!this.analyser) return this._vuResult || { peak: -100, rms: -100 };
    this.analyser.getFloatTimeDomainData(this._vuBuffer);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < this._vuBuffer.length; i++) {
      const v = Math.abs(this._vuBuffer[i]);
      if (v > peak) peak = v;
      sumSq += this._vuBuffer[i] * this._vuBuffer[i];
    }
    const rms = Math.sqrt(sumSq / this._vuBuffer.length);

    this._vuResult.peak = 20 * Math.log10(Math.max(peak, 1e-10));
    this._vuResult.rms = 20 * Math.log10(Math.max(rms, 1e-10));
    return this._vuResult;
  }

  /**
   * Get per-channel VU meter values (raw, unsmoothed).
   * @returns {Array<{peak: number, rms: number}>} array of {peak, rms} in dBFS per channel
   */
  getChannelVUMeters() {
    if (this._channelAnalysers.length === 0) {
      return [this.getVUMeter()];
    }
    const results = [];
    for (let ch = 0; ch < this._channelAnalysers.length; ch++) {
      const analyser = this._channelAnalysers[ch];
      const buf = this._channelBuffers[ch];
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
        sumSq += buf[i] * buf[i];
      }
      const rms = Math.sqrt(sumSq / buf.length);
      results.push({
        peak: 20 * Math.log10(Math.max(peak, 1e-10)),
        rms: 20 * Math.log10(Math.max(rms, 1e-10)),
      });
    }
    return results;
  }

  /**
   * Get frequency spectrum data as Float32Array of dB values.
   * Returns { data: Float32Array, binCount: number, sampleRate: number }
   */
  getSpectrumData() {
    if (!this.spectrumAnalyser) return null;
    this.spectrumAnalyser.getFloatFrequencyData(this._spectrumBuffer);
    return {
      data: this._spectrumBuffer,
      binCount: this.spectrumAnalyser.frequencyBinCount,
      sampleRate: this.audioCtx.sampleRate,
    };
  }

  /**
   * Get available playback speed options for the current file.
   */
  getSpeedOptions() {
    if (!this.wavInfo) return [];
    const sr = this.wavInfo.sampleRate;
    const options = [];
    const rates = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4];

    for (const r of rates) {
      const effectiveRate = sr * r;
      let rateStr;
      if (effectiveRate >= 1000) {
        const kHz = effectiveRate / 1000;
        rateStr = `${kHz % 1 === 0 ? kHz.toFixed(0) : kHz.toFixed(1)}kHz`;
      } else {
        rateStr = `${effectiveRate}Hz`;
      }
      let label;
      if (r === 1) {
        label = `${rateStr} (Original)`;
      } else if (r < 1) {
        const factor = Math.round(1 / r);
        label = `${rateStr} (${factor}x slower)`;
      } else {
        label = `${rateStr} (${r}x faster)`;
      }
      options.push({ rate: r, label });
    }

    return options;
  }

  destroy() {
    this.stop();
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    if (this.audioCtx) this.audioCtx.close();
  }
}
