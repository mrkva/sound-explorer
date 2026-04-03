/**
 * Audio playback engine using Web Audio API.
 * Handles loading, decoding, playback, and seeking.
 */

export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = null;

    this.isPlaying = false;
    this.startTime = 0;        // AudioContext time when playback started
    this.startOffset = 0;      // Offset into the buffer when playback started

    this.onTimeUpdate = null;  // Callback: (currentTime) => void
    this.onEnded = null;       // Callback: () => void
    this._animFrame = null;
  }

  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
  }

  async loadArrayBuffer(arrayBuffer) {
    if (!this.audioContext) await this.init();

    this.stop();
    // Make a copy since decodeAudioData detaches the buffer
    const copy = arrayBuffer.slice(0);
    this.audioBuffer = await this.audioContext.decodeAudioData(copy);
    return this.audioBuffer;
  }

  play(offset = null) {
    if (!this.audioBuffer) return;
    if (this.isPlaying) this.stop();

    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);

    const playOffset = offset !== null ? offset : this.startOffset;
    this.startOffset = Math.max(0, Math.min(playOffset, this.audioBuffer.duration));
    this.startTime = this.audioContext.currentTime;

    this.sourceNode.start(0, this.startOffset);
    this.isPlaying = true;

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.startOffset = 0;
        if (this.onEnded) this.onEnded();
      }
    };

    this._startTimeUpdate();
  }

  pause() {
    if (!this.isPlaying) return;
    this.startOffset = this.getCurrentTime();
    this._stopPlayback();
  }

  stop() {
    this.startOffset = 0;
    this._stopPlayback();
  }

  _stopPlayback() {
    if (this.sourceNode) {
      this.isPlaying = false;
      try { this.sourceNode.stop(); } catch (e) { /* ignore */ }
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    this._stopTimeUpdate();
  }

  seek(time) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this._stopPlayback();
    }
    this.startOffset = Math.max(0, Math.min(time, this.audioBuffer ? this.audioBuffer.duration : 0));
    if (wasPlaying) {
      this.play(this.startOffset);
    }
    if (this.onTimeUpdate) {
      this.onTimeUpdate(this.startOffset);
    }
  }

  getCurrentTime() {
    if (!this.audioBuffer) return 0;
    if (this.isPlaying) {
      const elapsed = this.audioContext.currentTime - this.startTime;
      return Math.min(this.startOffset + elapsed, this.audioBuffer.duration);
    }
    return this.startOffset;
  }

  getDuration() {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  setVolume(value) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, value));
    }
  }

  _startTimeUpdate() {
    const update = () => {
      if (this.isPlaying && this.onTimeUpdate) {
        this.onTimeUpdate(this.getCurrentTime());
      }
      if (this.isPlaying) {
        this._animFrame = requestAnimationFrame(update);
      }
    };
    this._animFrame = requestAnimationFrame(update);
  }

  _stopTimeUpdate() {
    if (this._animFrame) {
      cancelAnimationFrame(this._animFrame);
      this._animFrame = null;
    }
  }
}
