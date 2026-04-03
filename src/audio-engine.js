/**
 * Streaming audio engine.
 *
 * Uses an <audio> element pointed at a local HTTP server that serves
 * the stitched WAV data. Web Audio API is used for gain amplification
 * to hear faint sounds.
 */

export class AudioEngine {
  constructor() {
    this.audioContext = null;
    this.audioElement = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.analyserNode = null;

    this.isPlaying = false;
    this.duration = 0;
    this.audioUrl = null;

    this.onTimeUpdate = null;
    this.onEnded = null;
    this._animFrame = null;
  }

  async init() {
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Create audio element for streaming playback
    this.audioElement = document.createElement('audio');
    this.audioElement.preload = 'auto';

    // Connect through Web Audio API for gain control
    this.sourceNode = this.audioContext.createMediaElementSource(this.audioElement);
    this.gainNode = this.audioContext.createGain();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = 256;

    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioContext.destination);

    // Events
    this.audioElement.addEventListener('ended', () => {
      this.isPlaying = false;
      this._stopTimeUpdate();
      if (this.onEnded) this.onEnded();
    });

    this.audioElement.addEventListener('loadedmetadata', () => {
      this.duration = this.audioElement.duration;
    });
  }

  /**
   * Set the audio source URL (from local HTTP server).
   */
  async setSource(url) {
    if (!this.audioContext) await this.init();
    this.audioUrl = url;
    this.audioElement.src = url;
    // Wait for enough data to get duration
    return new Promise((resolve) => {
      const onMeta = () => {
        this.duration = this.audioElement.duration;
        this.audioElement.removeEventListener('loadedmetadata', onMeta);
        resolve();
      };
      this.audioElement.addEventListener('loadedmetadata', onMeta);
      // Also handle case where metadata is already loaded
      if (this.audioElement.readyState >= 1) {
        this.duration = this.audioElement.duration;
        resolve();
      }
    });
  }

  play() {
    if (!this.audioElement) return;
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    this.audioElement.play();
    this.isPlaying = true;
    this._startTimeUpdate();
  }

  pause() {
    if (!this.audioElement) return;
    this.audioElement.pause();
    this.isPlaying = false;
    this._stopTimeUpdate();
  }

  stop() {
    if (!this.audioElement) return;
    this.audioElement.pause();
    this.audioElement.currentTime = 0;
    this.isPlaying = false;
    this._stopTimeUpdate();
  }

  seek(time) {
    if (!this.audioElement) return;
    this.audioElement.currentTime = Math.max(0, Math.min(time, this.duration || 0));
    if (this.onTimeUpdate) {
      this.onTimeUpdate(this.audioElement.currentTime);
    }
  }

  getCurrentTime() {
    return this.audioElement ? this.audioElement.currentTime : 0;
  }

  getDuration() {
    return this.duration || 0;
  }

  /**
   * Set volume (0-1 range, normal volume).
   */
  setVolume(value) {
    if (this.audioElement) {
      this.audioElement.volume = Math.max(0, Math.min(1, value));
    }
  }

  /**
   * Set gain amplification in dB.
   * 0 dB = normal, +20 dB = 10x amplification, +40 dB = 100x.
   * This is how you hear faint wolf howls!
   */
  setGainDB(db) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.pow(10, db / 20);
    }
  }

  /**
   * Set playback speed.
   */
  setPlaybackRate(rate) {
    if (this.audioElement) {
      this.audioElement.playbackRate = rate;
    }
  }

  /**
   * Get current audio levels for a VU meter (peak values 0-1).
   */
  getLevels() {
    if (!this.analyserNode) return { peak: 0, rms: 0 };
    const data = new Float32Array(this.analyserNode.fftSize);
    this.analyserNode.getFloatTimeDomainData(data);

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) peak = abs;
      sumSq += data[i] * data[i];
    }
    return { peak, rms: Math.sqrt(sumSq / data.length) };
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
