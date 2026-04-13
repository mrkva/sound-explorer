/**
 * Live audio capture module.
 *
 * Uses getUserMedia + AudioWorklet (ScriptProcessor fallback) to capture
 * live audio from a microphone or sound card into a ring buffer.
 * The spectrogram reads from this buffer for real-time display.
 * Optionally records all captured audio for WAV export.
 */
export class LiveCapture {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.processorNode = null; // ScriptProcessor fallback

    this.sampleRate = 48000;
    this.channels = 1;
    this.isCapturing = false;
    this.isRecording = false;

    // Ring buffer for spectrogram display (last N seconds)
    this._bufferDuration = 30; // seconds of audio to keep
    this._ringBuffer = null;
    this._ringWritePos = 0;
    this._totalSamplesWritten = 0;

    // Recording buffer (grows unbounded while recording)
    this._recordChunks = [];
    this._recordSamples = 0;

    // Callbacks
    this.onData = null;        // (Float32Array) => void — called per audio block
    this.onLevelUpdate = null; // (peak, rms) => void — called per block

    // Device info
    this._deviceId = null;
  }

  /**
   * Enumerate available audio input devices.
   */
  static async getInputDevices() {
    // Request permission first (needed to get device labels)
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());
    } catch (e) {
      // Permission denied — return empty list
      return [];
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ id: d.deviceId, label: d.label || `Input ${d.deviceId.slice(0, 8)}...` }));
  }

  /**
   * Start capturing audio from the selected input device.
   */
  async start(deviceId = null, requestedSampleRate = null) {
    if (this.isCapturing) await this.stop();

    this._deviceId = deviceId;

    // Request high sample rate if available
    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    };
    if (deviceId) constraints.audio.deviceId = { exact: deviceId };
    if (requestedSampleRate) constraints.audio.sampleRate = { ideal: requestedSampleRate };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Get actual track settings
    const track = this.stream.getAudioTracks()[0];
    const settings = track.getSettings();
    const actualSR = settings.sampleRate || 48000;

    // Create AudioContext at the captured sample rate for zero-resampling
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: requestedSampleRate || actualSR
    });
    this.sampleRate = this.audioCtx.sampleRate;
    this.channels = 1; // mono capture for spectrogram

    // Allocate ring buffer
    const bufferSize = Math.ceil(this.sampleRate * this._bufferDuration);
    this._ringBuffer = new Float32Array(bufferSize);
    this._ringWritePos = 0;
    this._totalSamplesWritten = 0;

    // Create source from stream
    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);

    // Spectrum analyser for live frequency display
    this.spectrumAnalyser = this.audioCtx.createAnalyser();
    this.spectrumAnalyser.fftSize = 8192;
    this.spectrumAnalyser.smoothingTimeConstant = 0.7;
    this._spectrumBuffer = new Float32Array(this.spectrumAnalyser.frequencyBinCount);
    this.sourceNode.connect(this.spectrumAnalyser);

    // Try AudioWorklet first, fall back to ScriptProcessor
    try {
      await this._setupWorklet();
    } catch (e) {
      console.warn('AudioWorklet not available, using ScriptProcessor:', e.message);
      this._setupScriptProcessor();
    }

    this.isCapturing = true;
  }

  async _setupWorklet() {
    // Register the worklet processor inline via a Blob
    const workletCode = `
      class CaptureProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const input = inputs[0];
          if (input.length > 0) {
            // Send mono channel 0 to main thread
            this.port.postMessage({ samples: input[0] });
          }
          return true;
        }
      }
      registerProcessor('capture-processor', CaptureProcessor);
    `;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);

    this.workletNode = new AudioWorkletNode(this.audioCtx, 'capture-processor');
    this.workletNode.port.onmessage = (e) => {
      this._onAudioBlock(new Float32Array(e.data.samples));
    };
    this.sourceNode.connect(this.workletNode);
    // Don't connect to destination — we don't want to hear the input
  }

  _setupScriptProcessor() {
    // Fallback for older browsers
    this.processorNode = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processorNode.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      this._onAudioBlock(new Float32Array(data));
    };
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioCtx.destination);
  }

  _onAudioBlock(samples) {
    const ring = this._ringBuffer;
    const len = ring.length;

    // Write to ring buffer
    for (let i = 0; i < samples.length; i++) {
      ring[(this._ringWritePos + i) % len] = samples[i];
    }
    this._ringWritePos = (this._ringWritePos + samples.length) % len;
    this._totalSamplesWritten += samples.length;

    // Write to recording buffer if recording
    if (this.isRecording) {
      this._recordChunks.push(new Float32Array(samples));
      this._recordSamples += samples.length;
    }

    // Level metering
    if (this.onLevelUpdate) {
      let peak = 0, sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
        sumSq += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sumSq / samples.length);
      this.onLevelUpdate(peak, rms);
    }

    if (this.onData) this.onData(samples);
  }

  /**
   * Read the last N samples from the ring buffer (for spectrogram).
   */
  readLast(numSamples) {
    const ring = this._ringBuffer;
    if (!ring) return new Float32Array(numSamples);

    const len = ring.length;
    const available = Math.min(numSamples, this._totalSamplesWritten, len);
    const result = new Float32Array(numSamples);

    // Fill with silence if we don't have enough data yet
    const startOut = numSamples - available;
    const readStart = (this._ringWritePos - available + len) % len;

    for (let i = 0; i < available; i++) {
      result[startOut + i] = ring[(readStart + i) % len];
    }
    return result;
  }

  /**
   * Read a single sample by its absolute (global) index.
   * Returns 0 if the sample has been overwritten or is out of range.
   */
  readSample(globalIndex) {
    const ring = this._ringBuffer;
    if (!ring) return 0;
    const len = ring.length;
    const total = this._totalSamplesWritten;
    const oldest = total - len;
    if (globalIndex < oldest || globalIndex >= total) return 0;
    return ring[globalIndex % len];
  }

  /**
   * Get the total number of samples captured so far.
   */
  get totalSamples() {
    return this._totalSamplesWritten;
  }

  /**
   * Get frequency spectrum data as Float32Array of dB values.
   */
  getSpectrumData() {
    if (!this.spectrumAnalyser) return null;
    this.spectrumAnalyser.getFloatFrequencyData(this._spectrumBuffer);
    return {
      data: this._spectrumBuffer,
      binCount: this.spectrumAnalyser.frequencyBinCount,
      sampleRate: this.sampleRate,
    };
  }

  /**
   * Start recording captured audio for later WAV export.
   */
  startRecording() {
    this._recordChunks = [];
    this._recordSamples = 0;
    this._recordStartDate = new Date();
    this.isRecording = true;
  }

  /**
   * Stop recording and return the recorded audio as a WAV Blob.
   */
  stopRecording() {
    this.isRecording = false;
    if (this._recordSamples === 0) return null;

    // Merge chunks
    const merged = new Float32Array(this._recordSamples);
    let offset = 0;
    for (const chunk of this._recordChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this._recordChunks = [];
    this._recordSamples = 0;

    return this._float32ToWavBlob(merged, this.sampleRate, this._recordStartDate);
  }

  /**
   * Encode Float32 samples as a BWF (Broadcast Wave Format) blob.
   * Embeds a bext chunk with origination date/time and timeReference
   * so the recording carries wall-clock timecode metadata.
   */
  _float32ToWavBlob(samples, sampleRate, startDate) {
    const numSamples = samples.length;
    const bytesPerSample = 4; // 32-bit float
    const dataSize = numSamples * bytesPerSample;

    // bext chunk: 602 bytes of data + 8 bytes header = 610
    // Header total: RIFF(12) + fmt(24) + bext(610) + data header(8) = 654
    // 654 is NOT 4-byte aligned, so we write header and sample data as
    // separate buffers to avoid Float32Array alignment issues.
    const bextDataSize = 602;
    const bextChunkSize = 8 + bextDataSize;
    const headerSize = 12 + 24 + bextChunkSize + 8;
    const header = new ArrayBuffer(headerSize);
    const view = new DataView(header);
    let off = 0;

    const writeStr = (str, len) => {
      for (let i = 0; i < (len || str.length); i++) {
        view.setUint8(off + i, i < str.length ? str.charCodeAt(i) : 0);
      }
      off += len || str.length;
    };

    // RIFF header
    writeStr('RIFF');
    view.setUint32(off, headerSize - 8 + dataSize, true); off += 4;
    writeStr('WAVE');

    // fmt chunk
    writeStr('fmt ');
    view.setUint32(off, 16, true); off += 4;
    view.setUint16(off, 3, true); off += 2;            // IEEE float
    view.setUint16(off, 1, true); off += 2;            // mono
    view.setUint32(off, sampleRate, true); off += 4;
    view.setUint32(off, sampleRate * bytesPerSample, true); off += 4;
    view.setUint16(off, bytesPerSample, true); off += 2;
    view.setUint16(off, 32, true); off += 2;

    // bext chunk (BWF timecode metadata)
    writeStr('bext');
    view.setUint32(off, bextDataSize, true); off += 4;

    const d = startDate || new Date();
    const description = `Sound Explorer live recording`;
    writeStr(description, 256);                         // description
    writeStr('Sound Explorer', 32);                     // originator
    writeStr('', 32);                                   // originatorReference

    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    writeStr(dateStr, 10);                              // originationDate YYYY-MM-DD
    writeStr(timeStr, 8);                               // originationTime HH:MM:SS

    // timeReference: sample offset from midnight
    const secSinceMidnight = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    const timeRef = secSinceMidnight * sampleRate;
    view.setUint32(off, timeRef % 4294967296, true); off += 4;   // low 32 bits
    view.setUint32(off, Math.floor(timeRef / 4294967296), true); off += 4; // high 32 bits

    view.setUint16(off, 0, true); off += 2;            // version

    // UMID + reserved (254 bytes zeroed — already zero-initialized)
    off += 254;

    // data chunk
    writeStr('data');
    view.setUint32(off, dataSize, true); off += 4;

    // Sample data: reference the Float32Array's underlying buffer directly.
    // Kept separate from header to avoid Float32Array 4-byte alignment issues.
    const sampleBytes = new Uint8Array(samples.buffer, samples.byteOffset, dataSize);

    return new Blob([header, sampleBytes], { type: 'audio/wav' });
  }

  /**
   * Stop capturing and clean up all resources.
   */
  async stop() {
    this.isCapturing = false;
    this.isRecording = false;

    if (this.spectrumAnalyser) {
      this.spectrumAnalyser.disconnect();
      this.spectrumAnalyser = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch (e) {
        console.warn('AudioContext.close() error (ignored):', e);
      }
      this.audioCtx = null;
    }
  }
}
