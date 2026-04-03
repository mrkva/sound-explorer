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

    // Annotations
    this.annotations = [];
    this.annotationDialog = document.getElementById('annotation-dialog');
    this.annotationTimeInfo = document.getElementById('annotation-time-info');
    this.annotationNoteInput = document.getElementById('annotation-note');
    this.annotationsSidebar = document.getElementById('annotations-sidebar');
    this.annotationsList = document.getElementById('annotations-list');
    this.annotationCount = document.getElementById('annotation-count');
    this._pendingSelection = null; // {start, end} in session time
    this.selectionActions = document.getElementById('selection-actions');
    this.selectionInfo = document.getElementById('selection-info');

    // Audio output device
    this.audioOutputSelect = document.getElementById('audio-output');

    this._setupCanvas();
    this._setupSpectrogram();
    this._setupEventListeners();
    this._setupEngineCallbacks();
    this._startVUMeter();
    this._populateAudioOutputDevices();
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

    this.spectrogram.onSelectionChange = (start, end) => {
      if (start !== null && end !== null) {
        this._onSelectionMade(start, end);
      } else {
        this._onSelectionCleared();
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
      this.engine.clearLoop();
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

    // File info area - toggle file list
    this.fileInfoArea = document.getElementById('file-info-area');
    this.fileInfoHint = document.getElementById('file-info-hint');
    this.fileInfoArea.addEventListener('click', () => {
      if (this.session && this.session.files.length > 1) {
        this.fileListPanel.style.display =
          this.fileListPanel.style.display === 'none' ? 'block' : 'none';
      }
    });

    document.getElementById('btn-close-filelist').addEventListener('click', (e) => {
      e.stopPropagation();
      this.fileListPanel.style.display = 'none';
    });

    // Annotations sidebar toggle
    document.getElementById('btn-annotations').addEventListener('click', () => {
      this._toggleAnnotationsSidebar();
    });

    document.getElementById('btn-close-annotation').addEventListener('click', () => {
      this.annotationDialog.style.display = 'none';
    });

    document.getElementById('btn-save-annotation').addEventListener('click', () => {
      this._saveAnnotation();
    });

    this.annotationNoteInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Prevent keyboard shortcuts while typing
      if (e.key === 'Enter') this._saveAnnotation();
      if (e.key === 'Escape') {
        this.annotationDialog.style.display = 'none';
        this.annotationNoteInput.blur();
      }
    });

    // Selection toolbar actions - toggle annotation dialog
    document.getElementById('btn-annotate-selection').addEventListener('click', () => {
      if (this.annotationDialog.style.display !== 'none') {
        this.annotationDialog.style.display = 'none';
      } else if (this._pendingSelection) {
        this._showAnnotationDialog(this._pendingSelection.start, this._pendingSelection.end);
      }
    });

    document.getElementById('btn-export-selection').addEventListener('click', () => {
      this._exportSelectionAsWav();
    });

    document.getElementById('btn-close-sidebar').addEventListener('click', () => {
      this.annotationsSidebar.classList.remove('open');
      this._resizeCanvas();
    });

    document.getElementById('btn-export-annotations').addEventListener('click', () => {
      this._exportAnnotations();
    });

    document.getElementById('btn-export-all-wavs').addEventListener('click', () => {
      this._exportAllAnnotationsAsWav();
    });

    document.getElementById('btn-load-annotations').addEventListener('click', () => {
      this._loadAnnotations();
    });

    // Audio output device
    this.audioOutputSelect.addEventListener('change', (e) => {
      this._setAudioOutputDevice(e.target.value);
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
        case 'Escape':
          e.preventDefault();
          this.spectrogram.selectionStart = null;
          this.spectrogram.selectionEnd = null;
          this.spectrogram.draw();
          this._onSelectionCleared();
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
    // Show clickable hint if multi-file session
    if (session.files.length > 1) {
      this.fileInfoHint.textContent = `[${session.files.length} files - click]`;
    } else {
      this.fileInfoHint.textContent = '';
    }

    // Hide welcome overlay
    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';

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
      await this.engine.setSource(audioUrl, session.totalDuration, session.sampleRate);
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

  // ── Annotations ──────────────────────────────────────────────────────

  _onSelectionMade(start, end) {
    this._pendingSelection = { start, end };

    // Show selection info + action buttons in toolbar
    const dur = end - start;
    this.selectionInfo.textContent = this._formatTimePrecise(dur);
    this.selectionActions.style.display = 'flex';

    // Set up loop playback on the selection
    this.engine.setLoop(start, end);
    this.engine.seek(start);
    // Auto-play the loop
    if (!this.engine.isPlaying) {
      this.engine.play();
      this.btnPlay.textContent = '\u23F8 Pause';
    }
  }

  _onSelectionCleared() {
    this._pendingSelection = null;
    this.selectionActions.style.display = 'none';
    this.annotationDialog.style.display = 'none';
    this.engine.clearLoop();
  }

  _showAnnotationDialog(startTime, endTime) {
    this._pendingSelection = { start: startTime, end: endTime };

    // Build info text showing file references and wall clock
    const segments = this._getSelectionSegments(startTime, endTime);
    let info = '';

    for (const seg of segments) {
      info += `<div><b>${seg.fileName}</b>  ${this._formatTimePrecise(seg.startInFile)} \u2013 ${this._formatTimePrecise(seg.endInFile)}</div>`;
    }

    if (this.session?.sessionStartTime !== null) {
      const wallStart = this.session.toWallClock(startTime);
      const wallEnd = this.session.toWallClock(endTime);
      if (wallStart !== null && wallEnd !== null) {
        info += `<div class="wall-clock-label">Wall: ${BWFParser.secondsToTimeString(wallStart)} \u2013 ${BWFParser.secondsToTimeString(wallEnd)}</div>`;
      }
    }

    const duration = endTime - startTime;
    info += `<div>Duration: ${this._formatTimePrecise(duration)}</div>`;

    this.annotationTimeInfo.innerHTML = info;
    this.annotationDialog.style.display = 'block';
    this.annotationNoteInput.value = '';
    this.annotationNoteInput.focus();
  }

  _getSelectionSegments(startTime, endTime) {
    if (!this.session) return [];
    const segments = [];

    for (const file of this.session.files) {
      const fileEnd = file.timeStart + file.duration;
      // Check overlap
      if (startTime >= fileEnd || endTime <= file.timeStart) continue;

      const segStart = Math.max(startTime, file.timeStart);
      const segEnd = Math.min(endTime, fileEnd);
      segments.push({
        fileName: file.fileName,
        filePath: file.filePath,
        startInFile: segStart - file.timeStart,
        endInFile: segEnd - file.timeStart,
        wallClockStart: file.wallClockStart !== null ? file.wallClockStart + (segStart - file.timeStart) : null,
        wallClockEnd: file.wallClockStart !== null ? file.wallClockStart + (segEnd - file.timeStart) : null,
        originationDate: file.originationDate
      });
    }
    return segments;
  }

  _saveAnnotation() {
    if (!this._pendingSelection) return;
    const { start, end } = this._pendingSelection;
    const note = this.annotationNoteInput.value.trim() || 'untitled';

    const segments = this._getSelectionSegments(start, end);

    // Build wall clock ISO strings
    let wallClockStartISO = null;
    let wallClockEndISO = null;
    if (this.session?.sessionStartTime !== null) {
      const wallStart = this.session.toWallClock(start);
      const wallEnd = this.session.toWallClock(end);
      const date = this.session.sessionDate || '2000-01-01';
      if (wallStart !== null && wallEnd !== null) {
        wallClockStartISO = this._wallClockToISO(date, wallStart);
        wallClockEndISO = this._wallClockToISO(date, wallEnd);
      }
    }

    this.annotations.push({
      note,
      sessionStart: start,
      sessionEnd: end,
      segments,
      wallClockStartISO,
      wallClockEndISO
    });

    this.annotationDialog.style.display = 'none';
    this._pendingSelection = null;
    this._updateAnnotationsList();
    this._setStatus(`Annotation saved: "${note}"`);

    // Show annotations sidebar
    if (!this.annotationsSidebar.classList.contains('open')) {
      this._toggleAnnotationsSidebar();
    }
  }

  _wallClockToISO(dateStr, wallSeconds) {
    // dateStr is "YYYY-MM-DD" or "YYYY:MM:DD", wallSeconds is seconds from midnight
    const d = dateStr.replace(/:/g, '-');
    let s = wallSeconds;
    let dayOffset = 0;
    if (s >= 86400) { s -= 86400; dayOffset = 1; }
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    // Simple day increment for midnight crossing
    if (dayOffset > 0) {
      const parts = d.split('-');
      const dt = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]) + dayOffset);
      const ds = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      return `${ds}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    return `${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  _updateAnnotationsList() {
    this.annotationCount.textContent = this.annotations.length;
    this.annotationsList.innerHTML = '';

    for (let i = 0; i < this.annotations.length; i++) {
      const ann = this.annotations[i];
      const item = document.createElement('div');
      item.className = 'annotation-item';

      let wallStr = '';
      if (ann.wallClockStartISO && ann.wallClockEndISO) {
        wallStr = `${ann.wallClockStartISO} \u2013 ${ann.wallClockEndISO}`;
      }

      let fileStr = ann.segments.map(s =>
        `${s.fileName} [${this._formatTimePrecise(s.startInFile)}\u2013${this._formatTimePrecise(s.endInFile)}]`
      ).join(', ');

      item.innerHTML = `
        <span class="ann-note">${this._escapeHtml(ann.note)}</span>
        ${wallStr ? `<span class="ann-wall">${wallStr}</span>` : ''}
        <span class="ann-file">${this._escapeHtml(fileStr)}</span>
        <div class="ann-actions">
          <button class="goto-btn" data-index="${i}">Go to</button>
          <button class="export-btn" data-index="${i}">Export WAV</button>
          <button class="delete-btn" data-index="${i}">Delete</button>
        </div>
      `;

      this.annotationsList.appendChild(item);
    }

    // Wire up buttons
    this.annotationsList.querySelectorAll('.goto-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        const ann = this.annotations[idx];
        // Navigate to annotation
        const padding = Math.max(2, (ann.sessionEnd - ann.sessionStart) * 0.2);
        this.spectrogram.setView(ann.sessionStart - padding, ann.sessionEnd + padding);
        this.spectrogram.selectionStart = ann.sessionStart;
        this.spectrogram.selectionEnd = ann.sessionEnd;
        this.spectrogram.computeVisible();
        this.engine.seek(ann.sessionStart);
        this._updateTimeDisplays(ann.sessionStart);
      });
    });

    this.annotationsList.querySelectorAll('.export-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.index);
        this._exportAnnotationAsWav(this.annotations[idx]);
      });
    });

    this.annotationsList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.dataset.confirm === 'yes') {
          const idx = parseInt(btn.dataset.index);
          this.annotations.splice(idx, 1);
          this._updateAnnotationsList();
        } else {
          btn.dataset.confirm = 'yes';
          btn.textContent = 'Sure?';
          btn.classList.add('confirm');
          setTimeout(() => {
            btn.dataset.confirm = '';
            btn.textContent = 'Delete';
            btn.classList.remove('confirm');
          }, 2000);
        }
      });
    });

    // Sync annotations to spectrogram for timeline markers
    this._syncAnnotationsToSpectrogram();
  }

  _syncAnnotationsToSpectrogram() {
    if (this.spectrogram) {
      this.spectrogram.annotations = this.annotations.map(a => ({
        sessionStart: a.sessionStart,
        sessionEnd: a.sessionEnd,
        note: a.note
      }));
      this.spectrogram.draw();
    }
  }

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  async _exportAnnotations() {
    if (this.annotations.length === 0) {
      this._setStatus('No annotations to export');
      return;
    }

    const filePath = await window.electronAPI.saveFileDialog({
      title: 'Export Annotations',
      defaultPath: 'annotations.json',
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return;

    // Build export data
    const exportData = {
      exportedAt: new Date().toISOString(),
      session: this.session ? {
        files: this.session.files.map(f => f.fileName),
        sampleRate: this.session.sampleRate,
        date: this.session.sessionDate,
        totalDuration: this.session.totalDuration
      } : null,
      annotations: this.annotations.map(ann => ({
        note: ann.note,
        wallClockStart: ann.wallClockStartISO,
        wallClockEnd: ann.wallClockEndISO,
        sessionStart: ann.sessionStart,
        sessionEnd: ann.sessionEnd,
        segments: ann.segments.map(s => ({
          file: s.fileName,
          filePath: s.filePath,
          startInFile: s.startInFile,
          endInFile: s.endInFile,
          originationDate: s.originationDate
        }))
      }))
    };

    await window.electronAPI.writeFile(filePath, JSON.stringify(exportData, null, 2));

    // Also generate a cut script alongside
    const scriptPath = filePath.replace(/\.json$/, '') + '_cut.sh';
    const script = this._generateCutScript(exportData);
    await window.electronAPI.writeFile(scriptPath, script);

    this._setStatus(`Exported ${this.annotations.length} annotations to ${filePath}`);
  }

  _generateCutScript(exportData) {
    let script = '#!/bin/bash\n';
    script += '# Auto-generated by Field Recording Explorer\n';
    script += `# ${exportData.exportedAt}\n`;
    script += '# Requires: ffmpeg\n\n';
    script += 'set -e\n\n';
    script += 'OUTPUT_DIR="./cuts"\n';
    script += 'mkdir -p "$OUTPUT_DIR"\n\n';

    for (const ann of exportData.annotations) {
      // Build output filename: ISO range + note
      let outputName;
      if (ann.wallClockStart && ann.wallClockEnd) {
        outputName = `${ann.wallClockStart}--${ann.wallClockEnd}_${ann.note}`;
      } else {
        outputName = ann.note;
      }
      // Sanitize filename
      outputName = outputName.replace(/[<>:"/\\|?*]/g, '_');

      script += `# ${ann.note}\n`;

      for (const seg of ann.segments) {
        const startSec = seg.startInFile.toFixed(3);
        const duration = (seg.endInFile - seg.startInFile).toFixed(3);
        const srcFile = seg.filePath;

        // If multiple segments, append file index
        const suffix = ann.segments.length > 1
          ? `_${seg.file.replace(/\.[^.]+$/, '')}` : '';

        script += `ffmpeg -i "${srcFile}" -ss ${startSec} -t ${duration} -c copy "$OUTPUT_DIR/${outputName}${suffix}.wav"\n`;
      }
      script += '\n';
    }

    script += 'echo "Done! Cut files are in $OUTPUT_DIR"\n';
    return script;
  }

  _buildExportFilename(ann) {
    let name;
    if (ann.wallClockStartISO && ann.wallClockEndISO) {
      name = `${ann.wallClockStartISO}--${ann.wallClockEndISO}_${ann.note}`;
    } else {
      name = ann.note;
    }
    return name.replace(/[<>:"/\\|?*]/g, '_') + '.wav';
  }

  _buildExportSegments(ann) {
    const session = this.session;
    return ann.segments.map(seg => ({
      filePath: seg.filePath,
      dataOffset: session.files.find(f => f.filePath === seg.filePath)?.dataOffset || 0,
      startByte: Math.floor(seg.startInFile * session.sampleRate) * session.blockAlign,
      endByte: Math.ceil(seg.endInFile * session.sampleRate) * session.blockAlign,
      bitsPerSample: session.bitsPerSample,
      channels: session.channels,
      sampleRate: session.sampleRate,
      format: session.format
    }));
  }

  async _exportSelectionAsWav() {
    if (!this._pendingSelection || !this.session) return;
    const { start, end } = this._pendingSelection;
    const note = this.annotationNoteInput.value.trim() || 'selection';

    // Build a temporary annotation for the export
    const segments = this._getSelectionSegments(start, end);
    let wallClockStartISO = null;
    let wallClockEndISO = null;
    if (this.session.sessionStartTime !== null) {
      const wallStart = this.session.toWallClock(start);
      const wallEnd = this.session.toWallClock(end);
      const date = this.session.sessionDate || '2000-01-01';
      if (wallStart !== null && wallEnd !== null) {
        wallClockStartISO = this._wallClockToISO(date, wallStart);
        wallClockEndISO = this._wallClockToISO(date, wallEnd);
      }
    }

    const ann = { note, segments, wallClockStartISO, wallClockEndISO };
    await this._exportAnnotationAsWav(ann);
  }

  async _exportAnnotationAsWav(ann) {
    if (!this.session) return;

    const defaultName = this._buildExportFilename(ann);
    const outputPath = await window.electronAPI.saveFileDialog({
      title: 'Export WAV',
      defaultPath: defaultName,
      filters: [
        { name: 'WAV Audio', extensions: ['wav'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!outputPath) return;

    try {
      this._setStatus(`Exporting "${ann.note}"...`);
      const exportSegments = this._buildExportSegments(ann);
      const result = await window.electronAPI.exportWavSegment(exportSegments, outputPath);
      const sizeMB = (result.totalDataBytes / (1024 * 1024)).toFixed(1);
      this._setStatus(`Exported "${ann.note}" (${sizeMB} MB) to ${outputPath.split(/[/\\]/).pop()}`);
    } catch (err) {
      this._setStatus(`Export error: ${err.message}`);
      console.error('Export error:', err);
    }
  }

  async _exportAllAnnotationsAsWav() {
    if (this.annotations.length === 0 || !this.session) {
      this._setStatus('No annotations to export');
      return;
    }

    // Ask for output directory
    const dirPath = await window.electronAPI.openFolderDialog();
    if (!dirPath) return;

    let exported = 0;
    for (const ann of this.annotations) {
      try {
        const fileName = this._buildExportFilename(ann);
        const outputPath = dirPath + '/' + fileName;
        this._setStatus(`Exporting ${exported + 1}/${this.annotations.length}: "${ann.note}"...`);
        const exportSegments = this._buildExportSegments(ann);
        await window.electronAPI.exportWavSegment(exportSegments, outputPath);
        exported++;
      } catch (err) {
        console.error(`Failed to export "${ann.note}":`, err);
      }
    }

    this._setStatus(`Exported ${exported}/${this.annotations.length} annotations to ${dirPath.split(/[/\\]/).pop()}/`);
  }

  async _loadAnnotations() {
    const filePaths = await window.electronAPI.openFileDialog();
    if (!filePaths || filePaths.length === 0) return;

    // Find the .json file
    const jsonPath = filePaths.find(p => p.endsWith('.json')) || filePaths[0];

    try {
      const content = await window.electronAPI.readTextFile(jsonPath);
      const data = JSON.parse(content);

      if (!data.annotations || !Array.isArray(data.annotations)) {
        this._setStatus('Invalid annotations file');
        return;
      }

      // Convert loaded annotations to internal format
      for (const ann of data.annotations) {
        this.annotations.push({
          note: ann.note,
          sessionStart: ann.sessionStart,
          sessionEnd: ann.sessionEnd,
          segments: ann.segments.map(s => ({
            fileName: s.file,
            filePath: s.filePath,
            startInFile: s.startInFile,
            endInFile: s.endInFile,
            originationDate: s.originationDate,
            wallClockStart: null,
            wallClockEnd: null
          })),
          wallClockStartISO: ann.wallClockStart,
          wallClockEndISO: ann.wallClockEnd
        });
      }

      this._updateAnnotationsList();
      if (!this.annotationsSidebar.classList.contains('open')) {
        this._toggleAnnotationsSidebar();
      }
      this._setStatus(`Loaded ${data.annotations.length} annotations from ${jsonPath.split(/[/\\]/).pop()}`);
    } catch (err) {
      this._setStatus('Error loading annotations: ' + err.message);
    }
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

  // ── Annotations sidebar ──────────────────────────────────────────

  _toggleAnnotationsSidebar() {
    this.annotationsSidebar.classList.toggle('open');
    // After the CSS transition finishes, resize the canvas
    this._resizeCanvas();
    // Also resize after transition completes (200ms)
    setTimeout(() => this._resizeCanvas(), 220);
  }

  _resizeCanvas() {
    const container = this.canvas.parentElement;
    this.canvas.width = container.clientWidth;
    this.canvas.height = container.clientHeight;
    if (this.spectrogram && this.session) {
      this.spectrogram.draw(this.engine.getCurrentTime());
    }
  }

  // ── Audio output device selection ─────────────────────────────────

  async _populateAudioOutputDevices() {
    try {
      // Request permission to enumerate devices (some browsers need this)
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(t => t.stop());
        } catch (e) {
          // Permission denied is ok, we can still try to enumerate
        }
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

      this.audioOutputSelect.innerHTML = '<option value="">Default</option>';
      for (const device of audioOutputs) {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Output ${device.deviceId.slice(0, 8)}...`;
        this.audioOutputSelect.appendChild(opt);
      }

      // Listen for device changes (plugging in headphones etc.)
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this._populateAudioOutputDevices();
      });
    } catch (err) {
      console.warn('Could not enumerate audio devices:', err);
    }
  }

  async _setAudioOutputDevice(deviceId) {
    try {
      await this.engine.setSinkId(deviceId);
      const label = this.audioOutputSelect.selectedOptions[0]?.textContent || 'Default';
      this._setStatus(`Audio output: ${label}`);
    } catch (err) {
      console.error('Failed to set audio output device:', err);
      this._setStatus(`Failed to set output device: ${err.message}`);
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
