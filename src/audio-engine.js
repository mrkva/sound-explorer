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

  async init(sampleRate) {
    // Tear down previous context if sample rate changed or first init
    if (this.audioContext) {
      this._stopTimeUpdate();
      this.isPlaying = false;
      if (this.audioElement) {
        this.audioElement.pause();
        this.audioElement.removeAttribute('src');
        this.audioElement.load();
      }
      // Disconnect old nodes
      try { this.sourceNode?.disconnect(); } catch(e) {}
      try { this.gainNode?.disconnect(); } catch(e) {}
      try { this.analyserNode?.disconnect(); } catch(e) {}
      await this.audioContext.close();
      this.audioContext = null;
      this.sourceNode = null;
      this.audioElement = null;
    }

    // Create new context, optionally matching file sample rate
    const opts = sampleRate ? { sampleRate } : {};
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)(opts);

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
  /**
   * Set the audio source URL and known duration.
   * Duration is provided externally because stitched WAV files >4GB
   * can't encode their size in the WAV header, so the browser may
   * not determine duration correctly.
   */
  async setSource(url, knownDuration, sampleRate) {
    // Always reinit to get a fresh audio element and matching sample rate
    await this.init(sampleRate);
    this.audioUrl = url;
    this.duration = knownDuration || 0;
    this.audioElement.src = url;

    // Wait for the element to be ready enough to play, with a timeout
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        // Prefer known duration over what the browser reports
        if (knownDuration) {
          this.duration = knownDuration;
        } else if (this.audioElement.duration && isFinite(this.audioElement.duration)) {
          this.duration = this.audioElement.duration;
        }
        resolve();
      };

      this.audioElement.addEventListener('loadedmetadata', done, { once: true });
      this.audioElement.addEventListener('canplay', done, { once: true });
      this.audioElement.addEventListener('error', (e) => {
        console.error('Audio load error:', e);
        done();
      }, { once: true });

      // Timeout after 5 seconds - the audio may still stream fine
      setTimeout(done, 5000);
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
