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

import { WavParser } from './wav-parser.js?v=0.2.0';

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
    this.analyser.fftSize = 256;
    this._vuBuffer = new Float32Array(this.analyser.fftSize);
    this._vuResult = { peak: -100, rms: -100 };

    // Per-channel analysers (set up when file is loaded and channel count is known)
    this._channelAnalysers = [];
    this._channelBuffers = [];
    this._channelSplitter = null;

    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.audioCtx.destination);
  }

  _setupChannelAnalysers(numChannels) {
    // Clean up previous splitter
    if (this._channelSplitter) {
      this._channelSplitter.disconnect();
    }
    this._channelAnalysers = [];
    this._channelBuffers = [];

    if (numChannels <= 1) return;

    this._channelSplitter = this.audioCtx.createChannelSplitter(numChannels);
    this.gainNode.connect(this._channelSplitter);

    for (let i = 0; i < numChannels; i++) {
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
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
   * - For rate > 1 on low-SR files where effectiveSR <= 48kHz:
   *   include all samples, header SR = effectiveSR, browser plays at rate=1
   */
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
        const firstOutIdx = Math.ceil(pos / decimFactor);
        const lastSample = pos + count;
        const lastOutIdx = Math.ceil(lastSample / decimFactor);
        const outCount = lastOutIdx - firstOutIdx;
        if (outCount <= 0) continue;

        const outBuf = new ArrayBuffer(outCount * outBlockAlign);
        const outView = new DataView(outBuf);
        let outOff = 0;

        for (let i = firstOutIdx; i < lastOutIdx; i++) {
          const srcFrame = i * decimFactor;
          if (srcFrame < pos || srcFrame >= lastSample) continue;
          const localFrame = srcFrame - pos;
          const frameOff = localFrame * wavInfo.blockAlign;

          for (let ch = 0; ch < outChannels; ch++) {
            const sampleOff = frameOff + ch * (wavInfo.bitsPerSample / 8);
            const val = WavParser._readSample(view, sampleOff, wavInfo.format, wavInfo.bitsPerSample);
            const int16 = Math.max(-32768, Math.min(32767, Math.round(val * 32767)));
            outView.setInt16(outOff, int16, true);
            outOff += 2;
          }
        }

        if (outOff > 0) {
          parts.push(outBuf.slice(0, outOff));
        }
      }
    }

    const blob = new Blob(parts, { type: 'audio/wav' });
    // Release references to chunk buffers so GC can collect them
    parts.length = 0;
    // Yield to let GC settle before playback
    await new Promise(r => setTimeout(r, 50));
    const url = URL.createObjectURL(blob);

    // The blob duration = outSamples / headerSR
    // Original duration = totalSamples / origSR
    // timeScale = blobDuration / originalDuration
    this._blobDuration = outSamples / headerSR;
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
   * Get VU meter values.
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
   * Get per-channel VU meter values.
   * @returns {Array<{peak: number, rms: number}>} array of {peak, rms} in dBFS per channel
   */
  getChannelVUMeters() {
    if (this._channelAnalysers.length === 0) {
      // Mono — return main analyser as single channel
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
   * Get available playback speed options for the current file.
   */
  getSpeedOptions() {
    if (!this.wavInfo) return [];
    const sr = this.wavInfo.sampleRate;
    const options = [];
    const rates = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4];

    for (const r of rates) {
      const effectiveRate = sr * r;
      const displayRate = effectiveRate / 1000;
      const rateStr = displayRate >= 1
        ? displayRate.toFixed(displayRate % 1 === 0 ? 0 : 1)
        : displayRate.toFixed(2);
      let label;
      if (r === 1) {
        label = `${rateStr}kHz — Original`;
      } else if (r < 1) {
        const factor = Math.round(1 / r);
        label = `${rateStr}kHz — ${factor}x slower`;
      } else {
        label = `${rateStr}kHz — ${r}x faster`;
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
