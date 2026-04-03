/**
 * Main application - wires together BWF parser, spectrogram, and audio engine.
 */

import { BWFParser } from './bwf-parser.js';
import { SpectrogramRenderer } from './spectrogram.js';
import { AudioEngine } from './audio-engine.js';

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.spectrogram = null;
    this.metadata = null;

    // DOM elements
    this.canvas = document.getElementById('spectrogram');
    this.btnOpen = document.getElementById('btn-open');
    this.btnPlay = document.getElementById('btn-play');
    this.btnStop = document.getElementById('btn-stop');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomFit = document.getElementById('btn-zoom-fit');
    this.timeInput = document.getElementById('time-input');
    this.btnGoTo = document.getElementById('btn-goto');
    this.currentTimeDisplay = document.getElementById('current-time');
    this.wallTimeDisplay = document.getElementById('wall-time');
    this.durationDisplay = document.getElementById('duration');
    this.fileInfoDisplay = document.getElementById('file-info');
    this.statusDisplay = document.getElementById('status');
    this.volumeSlider = document.getElementById('volume');
    this.fftSizeSelect = document.getElementById('fft-size');
    this.dynamicRangeSlider = document.getElementById('dynamic-range');
    this.maxFreqInput = document.getElementById('max-freq');
    this.progressBar = document.getElementById('progress-bar');
    this.progressFill = document.getElementById('progress-fill');

    this._setupCanvas();
    this._setupSpectrogram();
    this._setupEventListeners();
    this._setupEngineCallbacks();
  }

  _setupCanvas() {
    const resizeCanvas = () => {
      const container = this.canvas.parentElement;
      this.canvas.width = container.clientWidth;
      this.canvas.height = container.clientHeight;
      if (this.spectrogram) {
        this.spectrogram.draw(this.engine.getCurrentTime());
      }
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
  }

  _setupSpectrogram() {
    this.spectrogram = new SpectrogramRenderer(this.canvas, {
      fftSize: parseInt(this.fftSizeSelect?.value || '2048'),
      dynamicRangeDB: parseInt(this.dynamicRangeSlider?.value || '90'),
      maxFreq: parseInt(this.maxFreqInput?.value || '22050')
    });

    this.spectrogram.onTimeClick = (time) => {
      this.engine.seek(time);
      this.spectrogram.draw(time);
      this._updateTimeDisplays(time);
    };

    this.spectrogram.onViewChange = () => {
      // Redraw with current playback position
      this.spectrogram.draw(this.engine.getCurrentTime());
    };
  }

  _setupEngineCallbacks() {
    this.engine.onTimeUpdate = (time) => {
      this._updateTimeDisplays(time);
      this.spectrogram.draw(time);
      this._updateProgressBar(time);
    };

    this.engine.onEnded = () => {
      this.btnPlay.textContent = '\u25B6 Play';
      this._updateProgressBar(0);
    };
  }

  _setupEventListeners() {
    // Open file
    this.btnOpen.addEventListener('click', () => this._openFile());

    // Play/Pause
    this.btnPlay.addEventListener('click', () => {
      if (this.engine.isPlaying) {
        this.engine.pause();
        this.btnPlay.textContent = '\u25B6 Play';
      } else {
        this.engine.play();
        this.btnPlay.textContent = '\u23F8 Pause';
      }
    });

    // Stop
    this.btnStop.addEventListener('click', () => {
      this.engine.stop();
      this.btnPlay.textContent = '\u25B6 Play';
      this.spectrogram.draw(0);
      this._updateTimeDisplays(0);
      this._updateProgressBar(0);
    });

    // Zoom
    this.btnZoomIn.addEventListener('click', () => {
      const center = (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 0.5);
    });

    this.btnZoomOut.addEventListener('click', () => {
      const center = (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 2);
    });

    this.btnZoomFit.addEventListener('click', () => {
      this.spectrogram.setView(0, this.spectrogram.totalDuration);
    });

    // Go to time
    this.btnGoTo.addEventListener('click', () => this._goToTime());
    this.timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._goToTime();
    });

    // Volume
    this.volumeSlider?.addEventListener('input', (e) => {
      this.engine.setVolume(parseFloat(e.target.value));
    });

    // Progress bar click
    this.progressBar?.addEventListener('click', (e) => {
      const rect = this.progressBar.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const time = ratio * this.engine.getDuration();
      this.engine.seek(time);
      this.spectrogram.draw(time);
      this._updateTimeDisplays(time);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.btnPlay.click();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.engine.seek(this.engine.getCurrentTime() - (e.shiftKey ? 10 : 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.engine.seek(this.engine.getCurrentTime() + (e.shiftKey ? 10 : 1));
          break;
        case 'Home':
          e.preventDefault();
          this.engine.seek(0);
          break;
        case 'End':
          e.preventDefault();
          this.engine.seek(this.engine.getDuration());
          break;
        case 'KeyF':
          e.preventDefault();
          this.btnZoomFit.click();
          break;
        case 'Equal':
        case 'NumpadAdd':
          e.preventDefault();
          this.btnZoomIn.click();
          break;
        case 'Minus':
        case 'NumpadSubtract':
          e.preventDefault();
          this.btnZoomOut.click();
          break;
      }
    });

    // Drag-and-drop
    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('drag-over');
    });

    document.body.addEventListener('dragleave', () => {
      document.body.classList.remove('drag-over');
    });

    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) this._loadFileFromDrop(file);
    });
  }

  async _openFile() {
    try {
      const filePath = await window.electronAPI.openFileDialog();
      if (!filePath) return;

      this._setStatus('Loading file...');
      const arrayBuffer = await window.electronAPI.readFile(filePath);
      await this._processFile(arrayBuffer, filePath.split(/[/\\]/).pop());
    } catch (err) {
      this._setStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  async _loadFileFromDrop(file) {
    try {
      this._setStatus('Loading file...');
      const arrayBuffer = await file.arrayBuffer();
      await this._processFile(arrayBuffer, file.name);
    } catch (err) {
      this._setStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  async _processFile(arrayBuffer, fileName) {
    // Parse BWF metadata
    this._setStatus('Parsing metadata...');
    try {
      this.metadata = BWFParser.parse(arrayBuffer);
    } catch (err) {
      console.warn('BWF parse warning:', err.message);
      this.metadata = null;
    }

    // Display file info
    this._displayFileInfo(fileName);

    // Decode audio
    this._setStatus('Decoding audio...');
    const audioBuffer = await this.engine.loadArrayBuffer(arrayBuffer);

    // Compute spectrogram
    this._setStatus('Computing spectrogram... (this may take a moment for long files)');
    this.spectrogram.maxFreq = Math.min(
      parseInt(this.maxFreqInput?.value || '22050'),
      audioBuffer.sampleRate / 2
    );
    this.spectrogram.fftSize = parseInt(this.fftSizeSelect?.value || '2048');
    this.spectrogram.dynamicRangeDB = parseInt(this.dynamicRangeSlider?.value || '90');

    await this.spectrogram.compute(audioBuffer);

    this._setStatus('Ready');
    this.durationDisplay.textContent = this._formatTime(audioBuffer.duration);
    this._updateTimeDisplays(0);

    // If we have a timecode, show hint
    if (this.metadata?.startTimeOfDay !== null && this.metadata?.startTimeOfDay !== undefined) {
      const startStr = BWFParser.secondsToTimeString(this.metadata.startTimeOfDay);
      const endSeconds = this.metadata.startTimeOfDay + audioBuffer.duration;
      const endStr = BWFParser.secondsToTimeString(endSeconds);
      this._setStatus(`Ready \u2014 Recording time: ${startStr} to ${endStr}. Type a wall-clock time to navigate.`);
    }
  }

  _displayFileInfo(fileName) {
    if (!this.metadata) {
      this.fileInfoDisplay.textContent = fileName;
      return;
    }

    const m = this.metadata;
    let info = `${fileName}  |  ${m.sampleRate} Hz  |  ${m.bitsPerSample}-bit  |  ${m.channels}ch`;
    if (m.originationDate) info += `  |  Date: ${m.originationDate}`;
    if (m.originationTime) info += `  |  Start: ${m.originationTime}`;
    if (m.bext?.originator) info += `  |  Recorder: ${m.bext.originator}`;
    this.fileInfoDisplay.textContent = info;
  }

  _goToTime() {
    const timeStr = this.timeInput.value.trim();
    if (!timeStr) return;

    const targetSeconds = BWFParser.parseTimeString(timeStr);
    if (targetSeconds === null) {
      this._setStatus('Invalid time format. Use HH:MM or HH:MM:SS');
      return;
    }

    // If we have BWF timecode, treat input as wall-clock time
    if (this.metadata?.startTimeOfDay !== null && this.metadata?.startTimeOfDay !== undefined) {
      const offsetInFile = targetSeconds - this.metadata.startTimeOfDay;
      if (offsetInFile < 0 || offsetInFile > this.engine.getDuration()) {
        const startStr = BWFParser.secondsToTimeString(this.metadata.startTimeOfDay);
        const endStr = BWFParser.secondsToTimeString(this.metadata.startTimeOfDay + this.engine.getDuration());
        this._setStatus(`Time ${timeStr} is outside recording range (${startStr} \u2013 ${endStr})`);
        return;
      }
      this.engine.seek(offsetInFile);

      // Zoom to show context around the target (30 seconds on each side)
      const viewPadding = 30;
      this.spectrogram.setView(
        Math.max(0, offsetInFile - viewPadding),
        Math.min(this.engine.getDuration(), offsetInFile + viewPadding)
      );
      this.spectrogram.draw(offsetInFile);
      this._setStatus(`Jumped to wall-clock time ${timeStr} (file position ${this._formatTime(offsetInFile)})`);
    } else {
      // No timecode - treat as file position
      if (targetSeconds > this.engine.getDuration()) {
        this._setStatus(`Time ${timeStr} exceeds file duration`);
        return;
      }
      this.engine.seek(targetSeconds);
      const viewPadding = 30;
      this.spectrogram.setView(
        Math.max(0, targetSeconds - viewPadding),
        Math.min(this.engine.getDuration(), targetSeconds + viewPadding)
      );
      this.spectrogram.draw(targetSeconds);
      this._setStatus(`Jumped to ${timeStr}`);
    }
  }

  _updateTimeDisplays(time) {
    this.currentTimeDisplay.textContent = this._formatTimePrecise(time);

    if (this.metadata?.startTimeOfDay !== null && this.metadata?.startTimeOfDay !== undefined) {
      const wallSeconds = this.metadata.startTimeOfDay + time;
      this.wallTimeDisplay.textContent = BWFParser.secondsToTimeString(wallSeconds);
      this.wallTimeDisplay.parentElement.style.display = '';
    } else {
      this.wallTimeDisplay.parentElement.style.display = 'none';
    }
  }

  _updateProgressBar(time) {
    if (!this.progressFill) return;
    const duration = this.engine.getDuration();
    const pct = duration > 0 ? (time / duration) * 100 : 0;
    this.progressFill.style.width = pct + '%';
  }

  _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  _formatTimePrecise(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }

  _setStatus(text) {
    this.statusDisplay.textContent = text;
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
