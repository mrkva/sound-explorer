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
   * Get the total number of samples captured so far.
   */
  get totalSamples() {
    return this._totalSamplesWritten;
  }

  /**
   * Start recording captured audio for later WAV export.
   */
  startRecording() {
    this._recordChunks = [];
    this._recordSamples = 0;
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

    return this._float32ToWavBlob(merged, this.sampleRate);
  }

  /**
   * Encode Float32 samples as a 32-bit float WAV blob.
   */
  _float32ToWavBlob(samples, sampleRate) {
    const numSamples = samples.length;
    const bytesPerSample = 4; // 32-bit float
    const dataSize = numSamples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // RIFF header
    this._writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    this._writeString(view, 8, 'WAVE');

    // fmt chunk
    this._writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // chunk size
    view.setUint16(20, 3, true);            // format: IEEE float
    view.setUint16(22, 1, true);            // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
    view.setUint16(32, bytesPerSample, true); // block align
    view.setUint16(34, 32, true);           // bits per sample

    // data chunk
    this._writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    // Write samples
    const floatView = new Float32Array(buffer, 44);
    floatView.set(samples);

    return new Blob([buffer], { type: 'audio/wav' });
  }

  _writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /**
   * Stop capturing and clean up all resources.
   */
  async stop() {
    this.isCapturing = false;
    this.isRecording = false;

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
        // iOS Safari may throw on AudioContext.close() — safe to ignore
        console.warn('AudioContext.close() error (ignored):', e);
      }
      this.audioCtx = null;
    }
  }
}
