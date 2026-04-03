/**
 * Main application - wires session, spectrogram, and audio engine together.
 */

import { BWFParser } from './bwf-parser.js';
import { SpectrogramRenderer } from './spectrogram.js';
import { AudioEngine } from './audio-engine.js';
import { Session } from './session.js';

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.spectrogram = null;
    this.session = null;

    // DOM elements
    this.canvas = document.getElementById('spectrogram');
    this.btnOpenFolder = document.getElementById('btn-open-folder');
    this.btnOpenFile = document.getElementById('btn-open-file');
    this.btnPlay = document.getElementById('btn-play');
    this.btnStop = document.getElementById('btn-stop');
    this.btnZoomIn = document.getElementById('btn-zoom-in');
    this.btnZoomOut = document.getElementById('btn-zoom-out');
    this.btnZoomFit = document.getElementById('btn-zoom-fit');
    this.timeInput = document.getElementById('time-input');
    this.btnGoTo = document.getElementById('btn-goto');
    this.currentTimeDisplay = document.getElementById('current-time');
    this.wallTimeDisplay = document.getElementById('wall-time');
    this.wallTimeGroup = document.getElementById('wall-time-group');
    this.durationDisplay = document.getElementById('duration');
    this.fileInfoDisplay = document.getElementById('file-info');
    this.statusDisplay = document.getElementById('status');
    this.volumeSlider = document.getElementById('volume');
    this.audioGainSlider = document.getElementById('audio-gain');
    this.spectGainSlider = document.getElementById('spect-gain');
    this.dynamicRangeSlider = document.getElementById('dynamic-range');
    this.fftSizeSelect = document.getElementById('fft-size');
    this.minFreqInput = document.getElementById('min-freq');
    this.maxFreqInput = document.getElementById('max-freq');
    this.freqPresetSelect = document.getElementById('freq-preset');
    this.logFreqCheckbox = document.getElementById('log-freq');
    this.playbackRateSelect = document.getElementById('playback-rate');
    this.vuFill = document.getElementById('vu-fill');
    this.fileListPanel = document.getElementById('file-list-panel');
    this.fileListBody = document.getElementById('file-list-body');

    this._setupCanvas();
    this._setupSpectrogram();
    this._setupEventListeners();
    this._setupEngineCallbacks();
    this._startVUMeter();
  }

  _setupCanvas() {
    const resize = () => {
      const container = this.canvas.parentElement;
      this.canvas.width = container.clientWidth;
      this.canvas.height = container.clientHeight;
      if (this.spectrogram && this.session) {
        this.spectrogram.draw(this.engine.getCurrentTime());
      }
    };
    window.addEventListener('resize', resize);
    resize();
  }

  _setupSpectrogram() {
    this.spectrogram = new SpectrogramRenderer(this.canvas, {
      fftSize: parseInt(this.fftSizeSelect.value),
      dynamicRangeDB: parseInt(this.dynamicRangeSlider.value),
      maxFreq: parseInt(this.maxFreqInput.value)
    });

    this.spectrogram.onTimeClick = (time) => {
      this.engine.seek(time);
      this.spectrogram.draw(time);
      this._updateTimeDisplays(time);
    };

    this.spectrogram.onViewChange = () => {
      // Debounced recompute handled internally by spectrogram
    };

    this.cursorFreq = document.getElementById('cursor-freq');
    this.cursorTime = document.getElementById('cursor-time');

    this.spectrogram.onCursorMove = (time, freq) => {
      if (time === null || freq === null) {
        this.cursorFreq.textContent = '-- Hz';
        this.cursorTime.textContent = '--:--';
        return;
      }
      // Format frequency
      if (freq >= 1000) {
        this.cursorFreq.textContent = (freq / 1000).toFixed(2) + ' kHz';
      } else {
        this.cursorFreq.textContent = Math.round(freq) + ' Hz';
      }
      // Show wall-clock time if available, otherwise file position
      if (this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined) {
        const wallSec = this.session.toWallClock(time);
        if (wallSec !== null) {
          this.cursorTime.textContent = BWFParser.secondsToTimeString(wallSec);
        }
      } else {
        this.cursorTime.textContent = this._formatTimePrecise(time);
      }
    };

    this.computingOverlay = document.getElementById('computing-overlay');
    this.computingLabel = document.getElementById('computing-label');
    this.computingBarFill = document.getElementById('computing-bar-fill');
    this.computingPercent = document.getElementById('computing-percent');

    this.spectrogram.onProgress = (phase, percent) => {
      if (phase === 'done' || phase === 'error') {
        this.computingOverlay.style.display = 'none';
        this._setStatus(phase === 'done' ? this._readyStatusMessage() : 'Spectrogram computation error');
      } else {
        this.computingOverlay.style.display = 'flex';
        const label = phase === 'reading' ? 'Reading audio data...' :
                      phase === 'computing' ? 'Computing spectrogram...' : 'Rendering...';
        this.computingLabel.textContent = label;
        this.computingBarFill.style.width = percent + '%';
        this.computingPercent.textContent = percent + '%';
        // Don't duplicate overlay info in status bar
      }
    };
  }

  _setupEngineCallbacks() {
    this.engine.onTimeUpdate = (time) => {
      this._updateTimeDisplays(time);
      this.spectrogram.draw(time);
    };

    this.engine.onEnded = () => {
      this.btnPlay.textContent = '\u25B6 Play';
    };
  }

  _setupEventListeners() {
    // Open folder
    this.btnOpenFolder.addEventListener('click', () => this._openFolder());

    // Open file(s)
    this.btnOpenFile.addEventListener('click', () => this._openFiles());

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
    });

    // Zoom
    this.btnZoomIn.addEventListener('click', () => {
      const center = (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 0.5);
      this.spectrogram.computeVisible();
    });

    this.btnZoomOut.addEventListener('click', () => {
      const center = (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 2);
      this.spectrogram.computeVisible();
    });

    this.btnZoomFit.addEventListener('click', () => {
      this.spectrogram.setView(0, this.spectrogram.totalDuration);
      this.spectrogram.computeVisible();
    });

    // Go to time
    this.btnGoTo.addEventListener('click', () => this._goToTime());
    this.timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._goToTime();
    });

    // Volume
    this.volumeSlider.addEventListener('input', (e) => {
      this.engine.setVolume(parseFloat(e.target.value));
    });

    // Audio gain (amplification)
    this.audioGainSlider.addEventListener('input', (e) => {
      this.engine.setGainDB(parseFloat(e.target.value));
    });

    // Spectrogram gain (visual) - instant re-render, no FFT recompute
    this.spectGainSlider.addEventListener('input', (e) => {
      this.spectrogram.gainDB = parseFloat(e.target.value);
      this.spectrogram.rerender();
    });

    // Dynamic range - instant re-render, no FFT recompute
    this.dynamicRangeSlider.addEventListener('input', (e) => {
      this.spectrogram.dynamicRangeDB = parseInt(e.target.value);
      this.spectrogram.rerender();
    });

    // FFT size
    this.fftSizeSelect.addEventListener('change', (e) => {
      this.spectrogram.fftSize = parseInt(e.target.value);
      this.spectrogram.tileCache.clear();
      this.spectrogram.computeVisible();
    });

    // Frequency range
    const applyFreqRange = () => {
      const nyquist = this.session ? this.session.sampleRate / 2 : 22050;
      this.spectrogram.minFreq = Math.max(0, parseInt(this.minFreqInput.value) || 0);
      this.spectrogram.maxFreq = Math.min(parseInt(this.maxFreqInput.value) || nyquist, nyquist);
      this.spectrogram.tileCache.clear();
      this.spectrogram.computeVisible();
    };
    this.minFreqInput.addEventListener('change', applyFreqRange);
    this.maxFreqInput.addEventListener('change', applyFreqRange);

    // Frequency presets
    this.freqPresetSelect.addEventListener('change', (e) => {
      const nyquist = this.session ? this.session.sampleRate / 2 : 22050;
      const presets = {
        full: [0, nyquist],
        bird: [100, 10000],
        voice: [80, 4000],
        low: [20, 500],
        mid: [200, 8000]
      };
      const [min, max] = presets[e.target.value] || presets.full;
      this.minFreqInput.value = min;
      this.maxFreqInput.value = Math.min(max, nyquist);
      applyFreqRange();
    });

    // Log frequency scale
    this.logFreqCheckbox.addEventListener('change', (e) => {
      this.spectrogram.logFrequency = e.target.checked;
      this.spectrogram.rerender();
    });

    // Playback rate
    this.playbackRateSelect.addEventListener('change', (e) => {
      this.engine.setPlaybackRate(parseFloat(e.target.value));
    });

    // File info bar - toggle file list
    this.fileInfoDisplay.parentElement.addEventListener('click', () => {
      if (this.session && this.session.files.length > 1) {
        this.fileListPanel.style.display =
          this.fileListPanel.style.display === 'none' ? 'block' : 'none';
      }
    });

    document.getElementById('btn-close-filelist').addEventListener('click', (e) => {
      e.stopPropagation();
      this.fileListPanel.style.display = 'none';
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

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
        case 'ArrowUp':
          e.preventDefault();
          this._adjustSpectGain(5);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._adjustSpectGain(-5);
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
        case 'KeyG':
          e.preventDefault();
          this.timeInput.focus();
          this.timeInput.select();
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
  }

  _adjustSpectGain(delta) {
    const current = parseFloat(this.spectGainSlider.value);
    const newVal = Math.max(0, Math.min(80, current + delta));
    this.spectGainSlider.value = newVal;
    this.spectGainSlider.dispatchEvent(new Event('input'));
    document.getElementById('spect-gain-value').textContent = `+${newVal} dB`;
  }

  async _openFolder() {
    try {
      const folderPath = await window.electronAPI.openFolderDialog();
      if (!folderPath) return;

      this._setStatus('Scanning folder...');
      this.session = new Session();
      await this.session.loadFolder(folderPath);
      await this._initSession();
    } catch (err) {
      this._setStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  async _openFiles() {
    try {
      const filePaths = await window.electronAPI.openFileDialog();
      if (!filePaths) return;

      this._setStatus(`Loading ${filePaths.length} file${filePaths.length > 1 ? 's' : ''}...`);
      this.session = new Session();
      if (filePaths.length === 1) {
        await this.session.loadFile(filePaths[0]);
      } else {
        await this.session.loadFiles(filePaths);
      }
      await this._initSession();
    } catch (err) {
      this._setStatus('Error: ' + err.message);
      console.error(err);
    }
  }

  async _initSession() {
    const session = this.session;

    // Display info
    this.fileInfoDisplay.textContent = session.getSummary();
    this.durationDisplay.textContent = this._formatTime(session.totalDuration);

    // Build file list
    this._buildFileList();

    // Set up spectrogram
    this._setStatus('Setting up spectrogram...');
    // Auto-select FFT size based on sample rate for good frequency resolution
    let fftSize = parseInt(this.fftSizeSelect.value);
    if (session.sampleRate > 48000 && fftSize < 4096) {
      fftSize = 4096;
      this.fftSizeSelect.value = '4096';
    }
    this.spectrogram.fftSize = fftSize;
    this.spectrogram.dynamicRangeDB = parseInt(this.dynamicRangeSlider.value);
    // Default frequency range to Nyquist
    const nyquist = session.sampleRate / 2;
    this.minFreqInput.value = 0;
    this.maxFreqInput.value = nyquist;
    this.spectrogram.minFreq = 0;
    this.spectrogram.maxFreq = nyquist;
    this.freqPresetSelect.value = 'full';
    this.spectrogram.gainDB = parseFloat(this.spectGainSlider.value);
    this.spectrogram.logFrequency = this.logFreqCheckbox.checked;
    this.spectrogram.setSession(session);

    // Start with a narrow initial view for instant display (2 minutes)
    // instead of fitting the entire multi-hour session
    const initialViewDuration = Math.min(120, session.totalDuration);
    this.spectrogram.setView(0, initialViewDuration);

    // Start audio setup and spectrogram compute in parallel
    this._setStatus('Loading...');
    const audioSetup = (async () => {
      const audioUrl = await window.electronAPI.setupAudioServer(session.getServerFileList());
      await this.engine.setSource(audioUrl, session.totalDuration);
      this.engine.setGainDB(parseFloat(this.audioGainSlider.value));
    })();

    // Compute spectrogram for initial narrow view (fast)
    await this.spectrogram.computeVisible();
    await audioSetup;

    // Show wall clock if available
    if (session.sessionStartTime !== null) {
      this.wallTimeGroup.style.display = '';
    } else {
      this.wallTimeGroup.style.display = 'none';
    }
    this._setStatus(this._readyStatusMessage());

    this._updateTimeDisplays(0);
  }

  _buildFileList() {
    this.fileListBody.innerHTML = '';
    for (const file of this.session.files) {
      const item = document.createElement('div');
      item.className = 'file-list-item';

      const wallStr = file.wallClockStart !== null
        ? BWFParser.secondsToTimeString(file.wallClockStart)
        : '';
      const durStr = this._formatTime(file.duration);

      item.innerHTML = `
        <span class="file-name">${file.fileName}</span>
        <span class="file-time">${wallStr}</span>
        <span class="file-duration">${durStr}</span>
      `;

      item.addEventListener('click', () => {
        this.engine.seek(file.timeStart);
        const viewDuration = Math.min(file.duration, 120);
        this.spectrogram.setView(file.timeStart, file.timeStart + viewDuration);
        this.spectrogram.computeVisible();
        this._updateTimeDisplays(file.timeStart);
        this.fileListPanel.style.display = 'none';
      });

      this.fileListBody.appendChild(item);
    }
  }

  _goToTime() {
    const timeStr = this.timeInput.value.trim();
    if (!timeStr) return;

    const targetSeconds = BWFParser.parseTimeString(timeStr);
    if (targetSeconds === null) {
      this._setStatus('Invalid time format. Use HH:MM or HH:MM:SS');
      return;
    }

    if (this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined) {
      // Treat as wall-clock time
      const fileTime = this.session.fromWallClock(targetSeconds);
      if (fileTime === null || fileTime < 0 || fileTime > this.session.totalDuration) {
        const startStr = BWFParser.secondsToTimeString(this.session.sessionStartTime);
        const endStr = BWFParser.secondsToTimeString(this.session.sessionEndTime);
        this._setStatus(`Time ${timeStr} is outside recording (${startStr}\u2013${endStr})`);
        return;
      }

      this.engine.seek(fileTime);
      // Zoom to 60-second window around target
      const padding = 30;
      this.spectrogram.setView(
        Math.max(0, fileTime - padding),
        Math.min(this.session.totalDuration, fileTime + padding)
      );
      this.spectrogram.computeVisible();
      this._setStatus(`Jumped to ${timeStr}`);
    } else {
      // Treat as file position
      if (targetSeconds > this.engine.getDuration()) {
        this._setStatus(`Time ${timeStr} exceeds duration`);
        return;
      }
      this.engine.seek(targetSeconds);
      const padding = 30;
      this.spectrogram.setView(
        Math.max(0, targetSeconds - padding),
        Math.min(this.engine.getDuration(), targetSeconds + padding)
      );
      this.spectrogram.computeVisible();
      this._setStatus(`Jumped to ${timeStr}`);
    }
  }

  _updateTimeDisplays(time) {
    this.currentTimeDisplay.textContent = this._formatTimePrecise(time);

    if (this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined) {
      const wallSec = this.session.toWallClock(time);
      if (wallSec !== null) {
        this.wallTimeDisplay.textContent = BWFParser.secondsToTimeString(wallSec);
      }
    }
  }


  _startVUMeter() {
    const update = () => {
      if (this.engine.isPlaying) {
        const { peak } = this.engine.getLevels();
        // Convert to percentage, with some scaling for visibility
        const pct = Math.min(100, peak * 100 * 1.5);
        this.vuFill.style.width = pct + '%';
      } else {
        this.vuFill.style.width = '0%';
      }
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
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

  _readyStatusMessage() {
    if (!this.session) return 'Ready';
    const s = this.session;
    if (s.sessionStartTime !== null) {
      const startStr = BWFParser.secondsToTimeString(s.sessionStartTime);
      const endStr = BWFParser.secondsToTimeString(s.sessionEndTime);
      return `Ready \u2014 ${s.files.length} file${s.files.length > 1 ? 's' : ''}, ${startStr}\u2013${endStr}. Type a time to navigate.`;
    }
    return 'Ready';
  }

  _setStatus(text) {
    this.statusDisplay.textContent = text;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
