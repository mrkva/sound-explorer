/**
 * Main application - wires session, spectrogram, and audio engine together.
 */

import { BWFParser } from './bwf-parser.js';
import { SpectrogramRenderer } from './spectrogram.js';
import { AudioEngine } from './audio-engine.js';
import { Session } from './session.js';
import { parseFRM, serializeFRM, autoPopulateFromSession, annotationsToFRM, annotationsFromFRM } from './frm.js';
import { buildIXML, parseIXML, formDataToIXML, ixmlToFormData, syncPointsToAnnotations } from './ixml.js';

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
    this.btnZoomSel = document.getElementById('btn-zoom-sel');
    this.timeInput = document.getElementById('time-input');
    this.gotoMode = document.getElementById('goto-mode');
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
    this.colorPresetSelect = document.getElementById('color-preset');
    this.channelSelect = document.getElementById('channel-select');
    this.channelControl = document.getElementById('channel-control');
    this.vuFill = document.getElementById('vu-fill');
    this.fileListPanel = document.getElementById('file-list-panel');
    this.fileListBody = document.getElementById('file-list-body');
    this.playbackFormatDisplay = document.getElementById('playback-format');
    this.dateInput = document.getElementById('date-input');
    this.dateLabel = document.getElementById('date-label');
    this.tcOffsetSelect = document.getElementById('tc-offset');
    this._tcOffsetHours = 0;

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
    this.selectionStartInput = document.getElementById('selection-start');
    this.selectionEndInput = document.getElementById('selection-end');
    this.selectionDurationPreset = document.getElementById('selection-duration-preset');

    // Audio output device and sample rate
    this.audioOutputSelect = document.getElementById('audio-output');
    this.outputSampleRateSelect = document.getElementById('output-samplerate');
    this._currentOutputSampleRate = 48000;
    this._currentDecimationFactor = 1;

    // Session metadata (iXML or FRM sidecar)
    this._sessionFolderPath = null;
    this._frmData = null;   // Parsed form data (from iXML or .frm.txt)
    this._frmLoaded = false; // Whether loaded from existing source
    this._ixmlSource = null; // 'ixml' | 'frm' | null — tracks metadata origin

    this._setupCanvas();
    this._setupSpectrogram();
    this._setupEventListeners();
    this._setupEngineCallbacks();
    this._setupDragAndDrop();
    this._startVUMeter();
    this._populateAudioOutputDevices();
    this._setupFRM();
  }

  _setupCanvas() {
    let resizeTimer = null;
    const resize = () => {
      const container = this.canvas.parentElement;
      this.canvas.width = container.clientWidth;
      this.canvas.height = container.clientHeight;
      if (this.spectrogram && this.session) {
        // Immediate redraw (stretches existing image to new size)
        this.spectrogram.draw(this.engine.getCurrentTime());
        // Debounced recompute so the spectrogram re-renders at correct resolution
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          this.spectrogram.tileCache.clear();
          this.spectrogram.computeVisible();
        }, 200);
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
          const adjusted = wallSec + (this._tcOffsetHours * 3600);
          this.cursorTime.textContent = BWFParser.secondsToTimeString(adjusted);
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
      // Auto-scroll: when cursor reaches right 10% of the view, advance the view
      if (this.engine.isPlaying && this.spectrogram && !this.engine.loopStart) {
        const viewDuration = this.spectrogram.viewEnd - this.spectrogram.viewStart;
        const threshold = this.spectrogram.viewStart + viewDuration * 0.9;
        if (time > threshold && time < this.spectrogram.totalDuration) {
          // Scroll forward, keeping cursor at left 10%
          const newStart = time - viewDuration * 0.1;
          this.spectrogram.setView(newStart, newStart + viewDuration);
          this.spectrogram.computeVisible();
        }
      }
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

    // Zoom — center on playback cursor, fall back to view center
    this.btnZoomIn.addEventListener('click', () => {
      const center = this.engine.getCurrentTime() || (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 0.5);
      this.spectrogram.computeVisible();
    });

    this.btnZoomOut.addEventListener('click', () => {
      const center = this.engine.getCurrentTime() || (this.spectrogram.viewStart + this.spectrogram.viewEnd) / 2;
      this.spectrogram.zoom(center, 2);
      this.spectrogram.computeVisible();
    });

    this.btnZoomFit.addEventListener('click', () => {
      this.spectrogram.setView(0, this.spectrogram.totalDuration);
      this.spectrogram.computeVisible();
    });

    this.btnZoomSel.addEventListener('click', () => this._zoomToSelection());

    // Go to time
    this.btnGoTo.addEventListener('click', () => this._goToTime());
    this.timeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._goToTime();
    });
    this.gotoMode.addEventListener('change', () => this._updateGoToPlaceholder());

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
      this.spectrogram._lastFFTData = null;
      this.spectrogram._computing = false; // Cancel any in-progress compute
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

    // Color preset
    this.colorPresetSelect.addEventListener('change', (e) => {
      this.spectrogram.colorPreset = e.target.value;
      this.spectrogram.rerender();
    });

    // Channel selector (supports single channel and split view)
    this.channelSelect.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val.startsWith('split:')) {
        const [a, b] = val.slice(6).split(',').map(Number);
        this.spectrogram.splitChannels = [a, b];
        this.spectrogram.channel = -1;
      } else {
        this.spectrogram.splitChannels = null;
        this.spectrogram.channel = parseInt(val);
      }
      this.spectrogram._lastFFTData = null;
      this.spectrogram._lastFFTDataSplit = null;
      this.spectrogram._computing = false;
      this.spectrogram.computeVisible();
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

    // Precise selection time inputs
    const applySelectionTime = () => {
      const startStr = this.selectionStartInput.value.trim();
      const endStr = this.selectionEndInput.value.trim();
      const startSec = this._parseFlexibleTime(startStr);
      const endSec = this._parseFlexibleTime(endStr);
      if (startSec !== null && endSec !== null && endSec > startSec) {
        this._applySelection(startSec, endSec);
      }
    };

    this.selectionStartInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { applySelectionTime(); e.target.blur(); }
      if (e.key === 'Escape') e.target.blur();
    });
    this.selectionEndInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { applySelectionTime(); e.target.blur(); }
      if (e.key === 'Escape') e.target.blur();
    });
    this.selectionStartInput.addEventListener('change', applySelectionTime);
    this.selectionEndInput.addEventListener('change', applySelectionTime);

    this.selectionDurationPreset.addEventListener('change', (e) => {
      const dur = parseFloat(e.target.value);
      if (!dur || !this._pendingSelection) return;
      const start = this._pendingSelection.start;
      this._applySelection(start, start + dur);
      e.target.value = ''; // Reset selector
    });

    document.getElementById('btn-export-selection').addEventListener('click', () => {
      this._exportSelectionAsWav();
    });

    this.btnExportSlowed = document.getElementById('btn-export-slowed');
    this.btnExportSlowed.addEventListener('click', () => {
      this._exportSelectionSlowed();
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

    // Timecode offset correction
    this.tcOffsetSelect.addEventListener('change', (e) => {
      this._tcOffsetHours = parseInt(e.target.value) || 0;
      // Update wall clock display immediately
      this._updateTimeDisplays(this.engine.getCurrentTime());
      this._setStatus(this._tcOffsetHours === 0
        ? 'Timecode offset cleared'
        : `Timecode offset: ${this._tcOffsetHours > 0 ? '+' : ''}${this._tcOffsetHours}h (applied to exports & display)`);
    });

    // "Play as" sample rate — changes playback speed like tape speed / sample rate reinterpretation
    this.outputSampleRateSelect.addEventListener('change', (e) => {
      this._changePlayAsRate(parseFloat(e.target.value));
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
        case 'KeyS':
          e.preventDefault();
          this._zoomToSelection();
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

    // Shortcuts modal
    const shortcutsModal = document.getElementById('shortcuts-modal');
    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      shortcutsModal.style.display = 'flex';
    });
    document.getElementById('btn-close-shortcuts').addEventListener('click', () => {
      shortcutsModal.style.display = 'none';
    });
    shortcutsModal.addEventListener('click', (e) => {
      if (e.target === shortcutsModal) shortcutsModal.style.display = 'none';
    });

    // Theme toggle
    const btnTheme = document.getElementById('btn-theme');
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    btnTheme.textContent = savedTheme === 'light' ? '\u2600' : '\u263D';
    btnTheme.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      btnTheme.textContent = next === 'light' ? '\u2600' : '\u263D';
      // Refresh spectrogram canvas colors
      if (this.spectrogram) {
        this.spectrogram._refreshThemeColors();
        this.spectrogram.draw();
      }
    });
  }

  _setupDragAndDrop() {
    // Prevent default browser drag behavior
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    document.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const files = [...e.dataTransfer.files];
      const wavFiles = files.filter(f => f.name.toLowerCase().endsWith('.wav'));

      if (wavFiles.length === 0) {
        this._setStatus('No WAV files found in drop');
        return;
      }

      try {
        // Get file paths from dropped files (Electron 33+ requires webUtils)
        const filePaths = wavFiles.map(f => {
          if (window.electronAPI.getPathForFile) {
            try { return window.electronAPI.getPathForFile(f); } catch (e) {}
          }
          return f.path;
        }).filter(p => p);
        if (filePaths.length === 0) {
          this._setStatus('Could not read file paths');
          return;
        }

        this._setStatus(`Loading ${filePaths.length} dropped file${filePaths.length > 1 ? 's' : ''}...`);
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
    });

    // Handle files opened via OS file association / command line
    if (window.electronAPI.onOpenFiles) {
      window.electronAPI.onOpenFiles(async (filePaths) => {
        if (!filePaths || filePaths.length === 0) return;
        try {
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
      });
    }
  }

  _zoomToSelection() {
    const s = this.spectrogram.selectionStart;
    const e = this.spectrogram.selectionEnd;
    if (s === null || e === null) return;
    const start = Math.min(s, e);
    const end = Math.max(s, e);
    if (end - start < 0.01) return;
    // Add 5% padding on each side
    const pad = (end - start) * 0.05;
    this.spectrogram.setView(start - pad, end + pad);
    this.spectrogram.computeVisible();
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

    // Track session folder path for FRM file operations
    if (session.files.length > 0) {
      this._sessionFolderPath = session.files[0].filePath.replace(/[/\\][^/\\]+$/, '');
    }
    // Reset metadata state
    this._frmData = null;
    this._frmLoaded = false;
    this._ixmlSource = null;

    // Clear previous annotations
    this.annotations = [];
    this._updateAnnotationsList();

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

    // Reset playback speed to native
    this.engine.setPlaybackRate(1);

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
      const result = await window.electronAPI.setupAudioServer(session.getServerFileList());
      this._currentOutputSampleRate = result.outputSampleRate;
      this._currentDecimationFactor = result.decimationFactor;
      await this.engine.setSource(result.url, session.totalDuration, result.outputSampleRate);
      this.engine.setGainDB(parseFloat(this.audioGainSlider.value));
      this._populateOutputSampleRateOptions(session.sampleRate);
    })();

    // Compute spectrogram for initial narrow view (fast)
    await this.spectrogram.computeVisible();
    await audioSetup;

    // Populate channel selector
    this._populateChannelSelector(session.channels);

    // Show wall clock if available
    if (session.sessionStartTime !== null) {
      this.wallTimeGroup.style.display = '';
    } else {
      this.wallTimeGroup.style.display = 'none';
    }

    // Update playback format display
    this._updatePlaybackFormat();

    // Populate date picker if multi-date session
    this._populateDatePicker();

    // Configure Go To mode and placeholder
    this._updateGoToPlaceholder();

    this._setStatus(this._readyStatusMessage());
    this._updateTimeDisplays(0);

    // Try to auto-load session.frm.txt first, then fall back to annotations.json
    await this._autoloadSessionData();
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
    const mode = this.gotoMode.value; // 'wall' or 'position'

    let targetSeconds = BWFParser.parseTimeString(timeStr);
    if (targetSeconds === null) {
      // Also try flexible format (M:SS, plain seconds)
      targetSeconds = this._parseFlexibleTime(timeStr);
    }
    if (targetSeconds === null) {
      this._setStatus('Invalid time format');
      return;
    }

    let fileTime;

    if (mode === 'wall' && this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined) {
      // Wall-clock mode: adjust for selected date if needed
      if (this.dateInput.style.display !== 'none' && this.dateInput.value && this.session?.sessionDate) {
        const sessionDate = this.session.sessionDate.replace(/:/g, '-');
        const selectedDate = this.dateInput.value;
        if (selectedDate !== sessionDate) {
          const sd = new Date(sessionDate);
          const td = new Date(selectedDate);
          const dayDiff = Math.round((td - sd) / 86400000);
          if (dayDiff > 0) targetSeconds += dayDiff * 86400;
        }
      }

      fileTime = this.session.fromWallClock(targetSeconds);
      if (fileTime === null || fileTime < 0 || fileTime > this.session.totalDuration) {
        const startStr = BWFParser.secondsToTimeString(this.session.sessionStartTime);
        const endStr = BWFParser.secondsToTimeString(this.session.sessionEndTime);
        this._setStatus(`Wall clock ${timeStr} is outside recording (${startStr}\u2013${endStr})`);
        return;
      }
    } else {
      // Position mode: treat as file position in seconds
      fileTime = targetSeconds;
      if (fileTime > this.engine.getDuration()) {
        this._setStatus(`Position ${timeStr} exceeds duration`);
        return;
      }
    }

    this.engine.seek(fileTime);
    const padding = 30;
    this.spectrogram.setView(
      Math.max(0, fileTime - padding),
      Math.min(this.session?.totalDuration || this.engine.getDuration(), fileTime + padding)
    );
    this.spectrogram.computeVisible();
    this._setStatus(`Jumped to ${timeStr} (${mode === 'wall' ? 'wall clock' : 'position'})`);
  }

  _updateTimeDisplays(time) {
    this.currentTimeDisplay.textContent = this._formatTimePrecise(time);

    if (this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined) {
      const wallSec = this.session.toWallClock(time);
      if (wallSec !== null) {
        const adjusted = wallSec + (this._tcOffsetHours * 3600);
        this.wallTimeDisplay.textContent = BWFParser.secondsToTimeString(adjusted);
      }
    }
  }


  _startVUMeter() {
    // Cancel previous loop if called again (prevents leak on session reload)
    if (this._vuRafId) cancelAnimationFrame(this._vuRafId);

    const peakHold = document.getElementById('vu-peak-hold');
    const dbfsValue = document.getElementById('vu-dbfs-value');
    let peakHoldLevel = 0;
    let peakHoldTimer = 0;
    let wasPlaying = false;
    const PEAK_HOLD_MS = 1500;
    const PEAK_DECAY_RATE = 0.0005; // per ms
    let lastTime = performance.now();

    const dbToPercent = (db) => Math.max(0, Math.min(100, (db + 60) / 60 * 100));

    const update = () => {
      const now = performance.now();
      const dt = now - lastTime;
      lastTime = now;

      if (this.engine.isPlaying) {
        wasPlaying = true;
        const { peak } = this.engine.getLevels();
        const dbfs = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
        const pct = dbToPercent(dbfs);
        this.vuFill.style.width = pct + '%';

        if (pct >= peakHoldLevel) {
          peakHoldLevel = pct;
          peakHoldTimer = PEAK_HOLD_MS;
        } else {
          peakHoldTimer -= dt;
          if (peakHoldTimer <= 0) {
            peakHoldLevel = Math.max(pct, peakHoldLevel - PEAK_DECAY_RATE * dt * 100);
          }
        }
        peakHold.style.left = peakHoldLevel + '%';
        peakHold.style.display = peakHoldLevel > 0 ? '' : 'none';

        if (dbfs > -60) {
          dbfsValue.textContent = dbfs.toFixed(1) + ' dB';
          dbfsValue.style.color = dbfs > -3 ? 'var(--danger)' : dbfs > -10 ? 'var(--orange)' : '';
        } else {
          dbfsValue.textContent = '-\u221E';
          dbfsValue.style.color = '';
        }
      } else if (wasPlaying) {
        // Reset once on stop, not every frame
        wasPlaying = false;
        peakHoldLevel = 0;
        peakHoldTimer = 0;
        this.vuFill.style.width = '0%';
        peakHold.style.display = 'none';
        dbfsValue.textContent = '-\u221E';
        dbfsValue.style.color = '';
      }
      this._vuRafId = requestAnimationFrame(update);
    };
    this._vuRafId = requestAnimationFrame(update);
  }

  _formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  _formatTimePrecise(seconds) {
    // Round to nearest centisecond first to avoid floating-point truncation
    // (e.g. 30.0 stored as 29.9999... would otherwise show as 0:29.99)
    const totalCs = Math.round(seconds * 100);
    const cs = totalCs % 100;
    const totalSec = Math.floor(totalCs / 100);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`;
  }

  /**
   * Parse flexible time string: supports H:MM:SS.cc, M:SS.cc, M:SS, or just seconds.
   */
  _parseFlexibleTime(str) {
    if (!str) return null;
    str = str.trim();
    // Try as plain number (seconds)
    if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
    // Try M:SS or M:SS.cc
    const parts = str.split(':');
    if (parts.length === 2) {
      const m = parseInt(parts[0], 10);
      const s = parseFloat(parts[1]);
      if (!isNaN(m) && !isNaN(s)) return m * 60 + s;
    }
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const s = parseFloat(parts[2]);
      if (!isNaN(h) && !isNaN(m) && !isNaN(s)) return h * 3600 + m * 60 + s;
    }
    return null;
  }

  _applySelection(start, end) {
    if (!this.session) return;
    start = Math.max(0, start);
    end = Math.min(this.session.totalDuration, end);
    if (end <= start) return;

    this.spectrogram.selectionStart = start;
    this.spectrogram.selectionEnd = end;
    this._onSelectionMade(start, end);

    // Zoom to show selection with padding
    const dur = end - start;
    const padding = Math.max(2, dur * 0.2);
    this.spectrogram.setView(start - padding, end + padding);
    this.spectrogram.computeVisible();
  }

  // ── Annotations ──────────────────────────────────────────────────────

  _onSelectionMade(start, end) {
    this._pendingSelection = { start, end };

    // Show selection info + action buttons in toolbar
    const dur = end - start;
    this.selectionInfo.textContent = this._formatTimePrecise(dur);
    this.selectionActions.style.display = 'flex';
    this._updateExportSlowedButton();

    // Populate precise time inputs
    this.selectionStartInput.value = this._formatTimePrecise(start);
    this.selectionEndInput.value = this._formatTimePrecise(end);

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
        const offsetSec = (this._tcOffsetHours || 0) * 3600;
        info += `<div class="wall-clock-label">Wall: ${BWFParser.secondsToTimeString(wallStart + offsetSec)} \u2013 ${BWFParser.secondsToTimeString(wallEnd + offsetSec)}</div>`;
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
    // Apply timecode offset correction
    wallSeconds += (this._tcOffsetHours || 0) * 3600;
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

  /**
   * Parse GPS coordinate string in various formats:
   * - "48.1486, 17.1077" (decimal)
   * - "49.2124267N, 21.1153514E" (map app format with N/S/E/W)
   * - "48.1486 17.1077" (space separated)
   * - "N48.1486, E17.1077"
   * Returns {lat, lon} or null if unparseable.
   */
  _parseGPS(str) {
    // Strip whitespace around separators
    const s = str.trim();
    if (!s) return null;

    // Try to match two numbers with optional N/S/E/W suffixes or prefixes
    // Pattern: optional NSEW, then number, optional NSEW, separator, repeat
    const re = /([NSEW]?)\s*(-?\d+\.?\d*)\s*([NSEW]?)[\s,]+([NSEW]?)\s*(-?\d+\.?\d*)\s*([NSEW]?)/i;
    const m = s.match(re);
    if (!m) return null;

    let lat = parseFloat(m[2]);
    let lon = parseFloat(m[5]);
    if (isNaN(lat) || isNaN(lon)) return null;

    // Apply direction from prefix or suffix
    const latDir = (m[1] || m[3] || '').toUpperCase();
    const lonDir = (m[4] || m[6] || '').toUpperCase();

    if (latDir === 'S') lat = -Math.abs(lat);
    if (latDir === 'N') lat = Math.abs(lat);
    if (lonDir === 'W') lon = -Math.abs(lon);
    if (lonDir === 'E') lon = Math.abs(lon);

    // Basic sanity check
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    return { lat, lon };
  }

  async _exportAnnotations() {
    if (this.annotations.length === 0) {
      this._setStatus('No annotations to export');
      return;
    }

    // Default: save annotations to the best available destination
    if (this._sessionFolderPath) {
      if (this._ixmlSource === 'ixml') {
        // Save as iXML SYNC_POINTs into WAV files
        if (!this._frmData) this._frmData = autoPopulateFromSession(this.session);
        const ixmlMeta = formDataToIXML(this._frmData, this.session, this.annotations);
        const xml = buildIXML(ixmlMeta);
        const results = await window.electronAPI.writeIXMLToFolder(this._sessionFolderPath, xml);
        const ok = results.filter(r => r.success).length;
        this._setStatus(`Saved ${this.annotations.length} annotations as iXML SYNC_POINTs to ${ok} WAV file${ok !== 1 ? 's' : ''}`);
        return;
      }
      // Save as session.frm.txt
      if (!this._frmData) this._frmData = autoPopulateFromSession(this.session);
      this._frmData.annotations = annotationsToFRM(this.annotations, this.session);
      const yaml = serializeFRM(this._frmData);
      const frmPath = this._sessionFolderPath + '/session.frm.txt';
      await window.electronAPI.writeFile(frmPath, yaml);
      this._frmLoaded = true;
      this._ixmlSource = 'frm';
      this._setStatus(`Saved ${this.annotations.length} annotations to session.frm.txt`);
      return;
    }

    // Fallback: save as JSON if no session folder
    let defaultPath = 'annotations.json';
    if (this.session && this.session.files.length > 0) {
      const dir = this.session.files[0].filePath.replace(/[/\\][^/\\]+$/, '');
      defaultPath = dir + '/annotations.json';
    }

    const filePath = await window.electronAPI.saveFileDialog({
      title: 'Export Annotations',
      defaultPath,
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

  async _exportSelectionSlowed() {
    if (!this._pendingSelection || !this.session) return;
    const speed = parseFloat(this.outputSampleRateSelect.value) || 1;
    if (speed === 1) return;

    const { start, end } = this._pendingSelection;
    const note = this.annotationNoteInput.value.trim() || 'selection';
    const targetSampleRate = Math.round(this.session.sampleRate * speed);
    const speedLabel = `${speed}x`;

    // Reuse shared segment/filename builders
    const segments = this._getSelectionSegments(start, end);
    const ann = { note, segments, wallClockStartISO: null, wallClockEndISO: null };

    if (this.session.sessionStartTime !== null) {
      const wallStart = this.session.toWallClock(start);
      const wallEnd = this.session.toWallClock(end);
      const date = this.session.sessionDate || '2000-01-01';
      if (wallStart !== null && wallEnd !== null) {
        ann.wallClockStartISO = this._wallClockToISO(date, wallStart);
        ann.wallClockEndISO = this._wallClockToISO(date, wallEnd);
      }
    }

    const baseName = this._buildExportFilename(ann).replace(/\.wav$/i, '');
    const defaultName = `${baseName}_${speedLabel}.wav`;

    const folderPath = this.session.files[0].filePath.replace(/[/\\][^/\\]+$/, '');
    const outputPath = await window.electronAPI.saveFileDialog({
      title: `Export at ${speedLabel} (${targetSampleRate} Hz)`,
      defaultPath: folderPath + '/' + defaultName,
      filters: [
        { name: 'WAV Audio', extensions: ['wav'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!outputPath) return;

    try {
      this._setStatus(`Exporting at ${speedLabel}...`);
      const exportSegments = this._buildExportSegments(ann);
      const bextMeta = this._buildBextMetadata(ann);

      const result = await window.electronAPI.exportWavResampled(
        exportSegments, outputPath, targetSampleRate, bextMeta
      );
      const sizeMB = (result.totalDataBytes / (1024 * 1024)).toFixed(1);
      this._setStatus(`Exported ${speedLabel} (${sizeMB} MB, ${targetSampleRate} Hz) to ${outputPath.split(/[/\\]/).pop()}`);
    } catch (err) {
      this._setStatus(`Export error: ${err.message}`);
      console.error('Export slowed error:', err);
    }
  }

  _buildBextMetadata(ann) {
    const session = this.session;
    if (!session || session.sessionStartTime === null) return null;

    // Calculate wall-clock time at the start of this annotation
    const startTime = ann.segments[0]?.startInFile || 0;
    const file = session.files.find(f => f.filePath === ann.segments[0]?.filePath);
    const sessionStart = file ? file.timeStart + startTime : startTime;
    const wallSec = session.toWallClock(sessionStart);
    if (wallSec === null) return null;

    const adjusted = wallSec + (this._tcOffsetHours || 0) * 3600;

    // TimeReference = samples since midnight (use modulo 86400 for time-of-day)
    const daySeconds = ((adjusted % 86400) + 86400) % 86400;
    const timeReference = Math.round(daySeconds * session.sampleRate);

    // OriginationDate and OriginationTime
    const date = session.sessionDate?.replace(/:/g, '-') || '2000-01-01';
    const totalSec = ((adjusted % 86400) + 86400) % 86400;
    const hh = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const mm = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const ss = String(Math.floor(totalSec % 60)).padStart(2, '0');
    const originationTime = `${hh}:${mm}:${ss}`;

    // Copy originator info from source file if available
    const bext = session.files[0]?.bext || {};

    return {
      description: ann.note || '',
      originator: bext.originator || 'Field Recording Explorer',
      originatorReference: bext.originatorReference || '',
      originationDate: date,
      originationTime,
      timeReference
    };
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
      const bextMeta = this._buildBextMetadata(ann);
      const result = await window.electronAPI.exportWavSegment(exportSegments, outputPath, bextMeta);
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
        const bextMeta = this._buildBextMetadata(ann);
        await window.electronAPI.exportWavSegment(exportSegments, outputPath, bextMeta);
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

    const filePath = filePaths[0];

    // Handle .frm.txt files
    if (filePath.endsWith('.frm.txt')) {
      try {
        const content = await window.electronAPI.readTextFile(filePath);
        const frmData = parseFRM(content);
        if (frmData.annotations && frmData.annotations.length > 0) {
          const appAnns = annotationsFromFRM(frmData.annotations, this.session);
          this.annotations.push(...appAnns);
          this._updateAnnotationsList();
          this.spectrogram.annotations = this.annotations;
          this.spectrogram.draw();
          if (!this.annotationsSidebar.classList.contains('open')) {
            this._toggleAnnotationsSidebar();
          }
          this._setStatus(`Loaded ${appAnns.length} annotations from ${filePath.split(/[/\\]/).pop()}`);
        }
      } catch (err) {
        this._setStatus('Error loading FRM file: ' + err.message);
      }
      return;
    }

    // JSON files
    const jsonPath = filePaths.find(p => p.endsWith('.json')) || filePath;
    const count = await this._loadAnnotationsFromFile(jsonPath);
    if (count > 0) {
      if (!this.annotationsSidebar.classList.contains('open')) {
        this._toggleAnnotationsSidebar();
      }
      this._setStatus(`Loaded ${count} annotations from ${jsonPath.split(/[/\\]/).pop()}`);
    }
  }

  async _loadAnnotationsFromFile(jsonPath) {
    try {
      const content = await window.electronAPI.readTextFile(jsonPath);
      const data = JSON.parse(content);

      if (!data.annotations || !Array.isArray(data.annotations)) return 0;

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
      return data.annotations.length;
    } catch (err) {
      return 0;
    }
  }

  async _autoloadSessionData() {
    if (!this.session || this.session.files.length === 0) return;

    const folderPath = this._sessionFolderPath;

    // 1. Try iXML from WAV files (embedded metadata — preferred)
    if (folderPath) {
      const ixmlLoaded = await this._loadIXMLFromFolder(folderPath);
      if (ixmlLoaded) return;
    } else if (this.session.files.length > 0) {
      // Single file mode — try reading iXML from the first file
      const ixmlLoaded = await this._loadIXMLFromFile(this.session.files[0].filePath);
      if (ixmlLoaded) return;
    }

    // 2. Try session.frm.txt sidecar
    if (folderPath) {
      const frmLoaded = await this._loadFRMFile(folderPath);
      if (frmLoaded) return;
    }

    // 3. Fall back to annotations.json
    if (!folderPath) return;
    const firstFilePath = this.session.files[0].filePath;
    const baseName = firstFilePath.replace(/^.*[/\\]/, '').replace(/\.[^.]+$/, '');
    const candidates = [
      folderPath + '/annotations.json',
      folderPath + '/' + baseName + '.annotations.json'
    ];

    for (const path of candidates) {
      const count = await this._loadAnnotationsFromFile(path);
      if (count > 0) {
        if (!this.annotationsSidebar.classList.contains('open')) {
          this._toggleAnnotationsSidebar();
        }
        this._setStatus(`Auto-loaded ${count} annotations from ${path.split(/[/\\]/).pop()}`);
        return;
      }
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

  // ── Output sample rate (decimation for ultrasonic content) ─────────

  _populateOutputSampleRateOptions(nativeSampleRate) {
    const select = this.outputSampleRateSelect;
    select.innerHTML = '';

    // Offer playback speed options as sample rate interpretations.
    // These are relative to the server output rate (which may differ from
    // native for high-SR files due to decimation).
    const serverRate = this._currentOutputSampleRate || nativeSampleRate;
    const speeds = [0.125, 0.25, 0.5, 1, 2, 4];

    for (const speed of speeds) {
      const interpretedRate = Math.round(nativeSampleRate * speed);
      const el = document.createElement('option');
      el.value = speed.toString();
      if (speed === 1) {
        const label = nativeSampleRate >= 1000 ? `${nativeSampleRate / 1000}kHz` : `${nativeSampleRate}Hz`;
        el.textContent = `${label} (native)`;
      } else {
        const label = interpretedRate >= 1000 ? `${interpretedRate / 1000}kHz` : `${interpretedRate}Hz`;
        el.textContent = `${label} (${speed}x)`;
      }
      select.appendChild(el);
    }

    select.value = '1';
  }

  _changePlayAsRate(speed) {
    if (!this.session) return;
    this.engine.setPlaybackRate(speed);

    if (speed === 1) {
      this._setStatus('Playback: native speed');
    } else {
      const interpretedRate = Math.round(this.session.sampleRate * speed);
      const label = interpretedRate >= 1000 ? `${interpretedRate / 1000}kHz` : `${interpretedRate}Hz`;
      this._setStatus(`Playing as ${label} (${speed}x speed)`);
    }
    this._updatePlaybackFormat();
    this._updateExportSlowedButton();
  }

  _updateExportSlowedButton() {
    const speed = parseFloat(this.outputSampleRateSelect.value) || 1;
    const btn = this.btnExportSlowed;
    if (speed !== 1 && this._pendingSelection) {
      btn.style.display = '';
      btn.textContent = `Export ${speed}x`;
      btn.title = `Export selection at ${speed}x speed (sample rate ${Math.round(this.session.sampleRate * speed)} Hz)`;
    } else {
      btn.style.display = 'none';
    }
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
      this.spectrogram.tileCache.clear();
      this.spectrogram.computeVisible();
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

  // ── Playback format display ─────────────────────────────────────────

  _updatePlaybackFormat() {
    if (!this.session) {
      this.playbackFormatDisplay.textContent = '--';
      return;
    }
    const rate = this._currentOutputSampleRate;
    const rateStr = rate >= 1000 ? `${rate / 1000}kHz` : `${rate}Hz`;
    const bits = this.session.bitsPerSample;
    const ch = this.session.channels === 1 ? 'mono' : this.session.channels === 2 ? 'stereo' : `${this.session.channels}ch`;
    const playAsSpeed = parseFloat(this.outputSampleRateSelect.value) || 1;
    const playAsStr = playAsSpeed !== 1 ? ` @${playAsSpeed}x` : '';
    this.playbackFormatDisplay.textContent = `${rateStr}/16bit ${ch}${playAsStr}`;
    this.playbackFormatDisplay.title = `Source: ${this.session.sampleRate}Hz/${bits}bit — Server: ${rate}Hz/16bit`;
  }

  // ── Channel selector ────────────────────────────────────────────────

  _populateChannelSelector(numChannels) {
    this.channelSelect.innerHTML = '';
    const channelLabels = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lb', 'Rb'];

    // Always offer mono mix
    const mixOpt = document.createElement('option');
    mixOpt.value = '-1';
    mixOpt.textContent = 'Mix';
    this.channelSelect.appendChild(mixOpt);

    if (numChannels > 1) {
      // Individual channels
      for (let i = 0; i < numChannels; i++) {
        const opt = document.createElement('option');
        opt.value = i.toString();
        const label = i < channelLabels.length ? channelLabels[i] : `${i + 1}`;
        opt.textContent = `${i + 1} (${label})`;
        this.channelSelect.appendChild(opt);
      }

      // Split view pairs
      const sep = document.createElement('option');
      sep.disabled = true;
      sep.textContent = '── split ──';
      this.channelSelect.appendChild(sep);

      for (let i = 0; i < numChannels; i++) {
        for (let j = i + 1; j < numChannels; j++) {
          // For stereo, just show L|R; for multichannel, show all pairs
          if (numChannels === 2 || j === i + 1) {
            const opt = document.createElement('option');
            opt.value = `split:${i},${j}`;
            const labelI = i < channelLabels.length ? channelLabels[i] : `${i + 1}`;
            const labelJ = j < channelLabels.length ? channelLabels[j] : `${j + 1}`;
            opt.textContent = `${labelI} | ${labelJ}`;
            this.channelSelect.appendChild(opt);
          }
        }
      }

      this.channelControl.style.display = '';
    } else {
      this.channelControl.style.display = 'none';
    }

    // Reset to mix
    this.channelSelect.value = '-1';
    this.spectrogram.channel = -1;
    this.spectrogram.splitChannels = null;
  }

  // ── Go To mode ──────────────────────────────────────────────────────

  _updateGoToPlaceholder() {
    const mode = this.gotoMode.value;
    const hasWallClock = this.session?.sessionStartTime !== null && this.session?.sessionStartTime !== undefined;

    if (mode === 'wall' && hasWallClock) {
      const startStr = BWFParser.secondsToTimeString(this.session.sessionStartTime);
      // Show start time as placeholder hint
      this.timeInput.placeholder = startStr.slice(0, 5); // e.g. "22:35"
      this.timeInput.title = `Wall clock time (${startStr} onwards)`;
    } else {
      // Position mode, or no wall clock available
      if (mode === 'wall' && !hasWallClock) {
        this.gotoMode.value = 'position'; // Auto-switch if no timecode
      }
      this.timeInput.placeholder = 'M:SS';
      this.timeInput.title = 'File position (M:SS or seconds)';
    }

    // Hide wall clock option if session has no timecode
    const wallOption = this.gotoMode.querySelector('option[value="wall"]');
    if (wallOption) {
      wallOption.disabled = !hasWallClock;
      if (!hasWallClock) this.gotoMode.value = 'position';
    }
  }

  // ── Date picker for multi-date sessions ─────────────────────────────

  _populateDatePicker() {
    if (!this.session || this.session.files.length === 0) {
      this.dateInput.style.display = 'none';
      this.dateLabel.style.display = 'none';
      return;
    }

    // Collect unique dates from files
    const dates = new Set();
    for (const file of this.session.files) {
      if (file.originationDate) {
        // Normalize YYYY:MM:DD → YYYY-MM-DD
        dates.add(file.originationDate.replace(/:/g, '-'));
      }
    }

    // Also check if a midnight crossing creates a second date
    if (this.session.sessionStartTime !== null && this.session.sessionEndTime !== null) {
      if (this.session.sessionEndTime > 86400 && this.session.sessionDate) {
        const baseDate = this.session.sessionDate.replace(/:/g, '-');
        const parts = baseDate.split('-');
        const nextDay = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]) + 1);
        const nextDateStr = `${nextDay.getFullYear()}-${String(nextDay.getMonth() + 1).padStart(2, '0')}-${String(nextDay.getDate()).padStart(2, '0')}`;
        dates.add(nextDateStr);
      }
    }

    if (dates.size <= 1) {
      this.dateInput.style.display = 'none';
      this.dateLabel.style.display = 'none';
      return;
    }

    // Show date picker
    this.dateLabel.style.display = '';
    this.dateInput.style.display = '';
    this.dateInput.innerHTML = '';

    const sortedDates = [...dates].sort();
    for (const d of sortedDates) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      this.dateInput.appendChild(opt);
    }
  }

  // ── FRM session metadata ────────────────────────────────────────────

  _setupFRM() {
    const modal = document.getElementById('frm-modal');
    const closeBtn = document.getElementById('frm-close');
    const saveBtn = document.getElementById('frm-save');
    const saveAsBtn = document.getElementById('frm-save-as');
    const saveIxmlBtn = document.getElementById('frm-save-ixml');
    const saveIxmlFileBtn = document.getElementById('frm-save-ixml-file');
    const openBtn = document.getElementById('btn-session-meta');

    openBtn.addEventListener('click', () => this._openFRMModal());
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });
    saveBtn.addEventListener('click', () => this._saveFRM());
    saveAsBtn.addEventListener('click', () => this._saveFRMAs());
    saveIxmlBtn.addEventListener('click', () => this._saveIXMLToFolder());
    saveIxmlFileBtn.addEventListener('click', () => this._saveIXMLToFile());

    // Add mic button
    document.getElementById('frm-add-mic').addEventListener('click', () => {
      this._addMicRow();
    });

    // Stop keyboard shortcuts when typing in the modal
    modal.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') modal.style.display = 'none';
    });
  }

  _openFRMModal() {
    if (!this.session) {
      this._setStatus('Open a recording session first');
      return;
    }

    // If no FRM data yet, auto-populate from session
    if (!this._frmData) {
      this._frmData = autoPopulateFromSession(this.session);
    }

    this._populateFRMForm(this._frmData);
    document.getElementById('frm-modal').style.display = 'flex';

    let statusText = 'Auto-populated from BWF metadata';
    if (this._ixmlSource === 'ixml') statusText = 'Loaded from iXML chunk';
    else if (this._ixmlSource === 'frm') statusText = 'Loaded from session.frm.txt';
    document.getElementById('frm-status').textContent = statusText;

    // Enable/disable folder save based on whether we have a folder
    const saveIxmlBtn = document.getElementById('frm-save-ixml');
    const hasFolder = !!this._sessionFolderPath;
    const fileCount = this.session?.files?.length || 0;
    saveIxmlBtn.disabled = !hasFolder;
    saveIxmlBtn.title = hasFolder
      ? `Embed iXML into all ${fileCount} WAV file${fileCount !== 1 ? 's' : ''} in ${this._sessionFolderPath.split(/[/\\]/).pop()}/`
      : 'Open a folder first to save iXML to all WAV files';

    // Configure single-file save button
    const saveIxmlFileBtn = document.getElementById('frm-save-ixml-file');
    if (fileCount > 0) {
      const fname = this.session.files[0].filePath.split(/[/\\]/).pop();
      saveIxmlFileBtn.disabled = false;
      saveIxmlFileBtn.title = `Embed iXML into ${fname}`;
    } else {
      saveIxmlFileBtn.disabled = true;
    }
  }

  _populateFRMForm(data) {
    const s = data.session || {};
    const dt = data.datetime || {};
    const loc = data.location || {};
    const cond = data.conditions || {};
    const eq = data.equipment || {};
    const rec = eq.recorder || {};

    document.getElementById('frm-title').value = s.title || '';
    document.getElementById('frm-project').value = s.project || '';
    document.getElementById('frm-recordist').value = s.recordist || '';
    document.getElementById('frm-license').value = s.license || '';
    document.getElementById('frm-tags').value = (s.tags || []).join(', ');

    document.getElementById('frm-dt-start').value = dt.start || '';
    document.getElementById('frm-dt-end').value = dt.end || '';
    document.getElementById('frm-dt-tz').value = dt.timezone || '';

    document.getElementById('frm-loc-name').value = loc.name || '';
    document.getElementById('frm-loc-region').value = loc.region || '';
    // Combine lat/lon into single GPS string
    if (loc.latitude != null && loc.longitude != null) {
      document.getElementById('frm-loc-gps').value = `${loc.latitude}, ${loc.longitude}`;
    } else {
      document.getElementById('frm-loc-gps').value = '';
    }
    document.getElementById('frm-loc-elev').value = loc.elevation_m != null ? loc.elevation_m : '';
    document.getElementById('frm-loc-env').value = loc.environment || '';

    document.getElementById('frm-cond-weather').value = cond.weather || '';
    document.getElementById('frm-cond-temp').value = cond.temperature_c != null ? cond.temperature_c : '';
    document.getElementById('frm-cond-hum').value = cond.humidity_pct != null ? cond.humidity_pct : '';
    document.getElementById('frm-cond-wind').value = cond.wind || '';
    document.getElementById('frm-cond-noise').value = cond.noise_floor || '';

    document.getElementById('frm-eq-model').value = rec.model || '';
    document.getElementById('frm-eq-sr').value = rec.sample_rate || '';
    document.getElementById('frm-eq-bits').value = rec.bit_depth || '';
    document.getElementById('frm-eq-phantom').checked = !!rec.phantom_power;
    document.getElementById('frm-eq-pip').checked = !!rec.plug_in_power;
    document.getElementById('frm-eq-limiter').checked = !!rec.limiter;
    document.getElementById('frm-eq-gain').value = Array.isArray(rec.gain_db)
      ? rec.gain_db.join(', ') : (rec.gain_db || '');
    document.getElementById('frm-eq-hp').value = rec.highpass_hz != null
      ? (rec.highpass_hz === false ? 'off' : rec.highpass_hz) : '';
    document.getElementById('frm-eq-setup').value = eq.setup || '';
    document.getElementById('frm-eq-acc').value = (eq.accessories || []).join(', ');

    document.getElementById('frm-notes').value =
      typeof data.notes === 'string' ? data.notes.replace(/\n$/, '') : '';

    // Microphones
    const micsList = document.getElementById('frm-mics-list');
    micsList.innerHTML = '';
    const mics = eq.microphones || [];
    for (const mic of mics) {
      this._addMicRow(mic);
    }

    // Channels
    const channelsList = document.getElementById('frm-channels-list');
    channelsList.innerHTML = '';
    const channels = data.channels || {};
    for (const [num, ch] of Object.entries(channels)) {
      const row = document.createElement('div');
      row.className = 'frm-channel-entry';
      row.innerHTML = `
        <span>${num}</span>
        <input type="text" class="frm-ch-label" value="${this._escapeHtml(ch.label || '')}" placeholder="Label">
        <input type="text" class="frm-ch-source" value="${this._escapeHtml(ch.source || '')}" placeholder="Mic ID">
      `;
      channelsList.appendChild(row);
    }
  }

  _addMicRow(mic = {}) {
    const list = document.getElementById('frm-mics-list');
    const row = document.createElement('div');
    row.className = 'frm-mic-entry';
    row.innerHTML = `
      <input type="text" class="frm-mic-id" value="${this._escapeHtml(mic.id || '')}" placeholder="ID">
      <input type="text" class="frm-mic-model" value="${this._escapeHtml(mic.model || '')}" placeholder="Model">
      <input type="text" class="frm-mic-type" value="${this._escapeHtml(mic.type || '')}" placeholder="Type">
      <button class="frm-remove-btn" title="Remove">&times;</button>
    `;
    row.querySelector('.frm-remove-btn').addEventListener('click', () => row.remove());
    list.appendChild(row);
  }

  _readFRMForm() {
    const data = {};

    // Session
    const title = document.getElementById('frm-title').value.trim();
    const project = document.getElementById('frm-project').value.trim();
    const recordist = document.getElementById('frm-recordist').value.trim();
    const license = document.getElementById('frm-license').value.trim();
    const tagsStr = document.getElementById('frm-tags').value.trim();
    const session = {};
    if (title) session.title = title;
    if (project) session.project = project;
    if (recordist) session.recordist = recordist;
    if (license) session.license = license;
    if (tagsStr) session.tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
    if (Object.keys(session).length) data.session = session;

    // Datetime
    const dtStart = document.getElementById('frm-dt-start').value.trim();
    const dtEnd = document.getElementById('frm-dt-end').value.trim();
    const dtTz = document.getElementById('frm-dt-tz').value.trim();
    const datetime = {};
    if (dtStart) datetime.start = dtStart;
    if (dtEnd) datetime.end = dtEnd;
    if (dtTz) datetime.timezone = dtTz;
    if (Object.keys(datetime).length) data.datetime = datetime;

    // Location
    const loc = {};
    const locName = document.getElementById('frm-loc-name').value.trim();
    const locRegion = document.getElementById('frm-loc-region').value.trim();
    const locGps = document.getElementById('frm-loc-gps').value.trim();
    const locElev = document.getElementById('frm-loc-elev').value.trim();
    const locEnv = document.getElementById('frm-loc-env').value.trim();
    if (locName) loc.name = locName;
    if (locRegion) loc.region = locRegion;
    if (locGps) {
      const coords = this._parseGPS(locGps);
      if (coords) {
        loc.latitude = coords.lat;
        loc.longitude = coords.lon;
      }
    }
    if (locElev) loc.elevation_m = parseFloat(locElev);
    if (locEnv) loc.environment = locEnv;
    if (Object.keys(loc).length) data.location = loc;

    // Conditions
    const cond = {};
    const weather = document.getElementById('frm-cond-weather').value.trim();
    const temp = document.getElementById('frm-cond-temp').value.trim();
    const hum = document.getElementById('frm-cond-hum').value.trim();
    const wind = document.getElementById('frm-cond-wind').value.trim();
    const noise = document.getElementById('frm-cond-noise').value.trim();
    if (weather) cond.weather = weather;
    if (temp) cond.temperature_c = parseFloat(temp);
    if (hum) cond.humidity_pct = parseFloat(hum);
    if (wind) cond.wind = wind;
    if (noise) cond.noise_floor = noise;
    if (Object.keys(cond).length) data.conditions = cond;

    // Equipment
    const eq = {};
    const rec = {};
    const model = document.getElementById('frm-eq-model').value.trim();
    const sr = document.getElementById('frm-eq-sr').value.trim();
    const bits = document.getElementById('frm-eq-bits').value.trim();
    const gainStr = document.getElementById('frm-eq-gain').value.trim();
    const hpStr = document.getElementById('frm-eq-hp').value.trim();
    if (model) rec.model = model;
    if (sr) rec.sample_rate = parseInt(sr);
    if (bits) rec.bit_depth = /float/i.test(bits) ? bits : parseInt(bits);
    if (document.getElementById('frm-eq-phantom').checked) rec.phantom_power = true;
    if (document.getElementById('frm-eq-pip').checked) rec.plug_in_power = true;
    if (document.getElementById('frm-eq-limiter').checked) rec.limiter = true;
    if (gainStr) {
      const gains = gainStr.split(',').map(g => parseFloat(g.trim())).filter(g => !isNaN(g));
      rec.gain_db = gains.length === 1 ? gains[0] : gains;
    }
    if (hpStr) rec.highpass_hz = hpStr.toLowerCase() === 'off' ? false : parseFloat(hpStr);
    if (Object.keys(rec).length) eq.recorder = rec;

    // Microphones
    const micRows = document.querySelectorAll('#frm-mics-list .frm-mic-entry');
    const mics = [];
    for (const row of micRows) {
      const id = row.querySelector('.frm-mic-id').value.trim();
      const micModel = row.querySelector('.frm-mic-model').value.trim();
      const micType = row.querySelector('.frm-mic-type').value.trim();
      if (id || micModel) {
        const mic = {};
        if (id) mic.id = id;
        if (micModel) mic.model = micModel;
        if (micType) mic.type = micType;
        mics.push(mic);
      }
    }
    if (mics.length) eq.microphones = mics;

    const setup = document.getElementById('frm-eq-setup').value.trim();
    if (setup) eq.setup = setup;
    const accStr = document.getElementById('frm-eq-acc').value.trim();
    if (accStr) eq.accessories = accStr.split(',').map(a => a.trim()).filter(Boolean);
    if (Object.keys(eq).length) data.equipment = eq;

    // Channels
    const chRows = document.querySelectorAll('#frm-channels-list .frm-channel-entry');
    const channels = {};
    for (const row of chRows) {
      const num = row.querySelector('span').textContent.trim();
      const label = row.querySelector('.frm-ch-label').value.trim();
      const source = row.querySelector('.frm-ch-source').value.trim();
      if (label || source) channels[num] = { label, source };
    }
    if (Object.keys(channels).length) data.channels = channels;

    // Files from existing FRM data (auto-populated, not editable in form)
    if (this._frmData?.files?.length) data.files = this._frmData.files;

    // Annotations from app state
    if (this.annotations.length > 0 && this.session) {
      data.annotations = annotationsToFRM(this.annotations, this.session);
    }

    // Notes
    const notes = document.getElementById('frm-notes').value.trim();
    if (notes) data.notes = notes + '\n';

    // Preserve custom keys from loaded FRM
    if (this._frmData) {
      for (const key of Object.keys(this._frmData)) {
        if (key.startsWith('x-') && !(key in data)) {
          data[key] = this._frmData[key];
        }
      }
    }

    return data;
  }

  async _saveFRM() {
    if (!this._sessionFolderPath) {
      this._setStatus('No session folder path — use Save As...');
      return this._saveFRMAs();
    }
    const frmPath = this._sessionFolderPath + '/session.frm.txt';
    await this._writeFRM(frmPath);
  }

  async _saveFRMAs() {
    let defaultPath = 'session.frm.txt';
    if (this._sessionFolderPath) {
      defaultPath = this._sessionFolderPath + '/session.frm.txt';
    }
    const filePath = await window.electronAPI.saveFileDialog({
      title: 'Save Session Metadata',
      defaultPath,
      filters: [
        { name: 'FRM Metadata', extensions: ['frm.txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });
    if (!filePath) return;
    await this._writeFRM(filePath);
  }

  async _writeFRM(frmPath) {
    const data = this._readFRMForm();
    const yaml = serializeFRM(data);
    await window.electronAPI.writeFile(frmPath, yaml);
    this._frmData = data;
    this._frmLoaded = true;
    this._ixmlSource = 'frm';
    document.getElementById('frm-status').textContent = 'Saved .frm.txt';
    this._setStatus(`Saved session metadata to ${frmPath.split(/[/\\]/).pop()}`);
  }

  async _loadFRMFile(folderPath) {
    const frmPath = folderPath + '/session.frm.txt';
    try {
      const exists = await window.electronAPI.fileExists(frmPath);
      if (!exists) return false;
      const content = await window.electronAPI.readTextFile(frmPath);
      this._frmData = parseFRM(content);
      this._frmLoaded = true;
      this._ixmlSource = 'frm';

      // Load annotations from FRM
      if (this._frmData.annotations && this._frmData.annotations.length > 0) {
        const appAnns = annotationsFromFRM(this._frmData.annotations, this.session);
        if (appAnns.length > 0) {
          this.annotations = appAnns;
          this._updateAnnotationsList();
          this.spectrogram.annotations = this.annotations;
          if (!this.annotationsSidebar.classList.contains('open')) {
            this._toggleAnnotationsSidebar();
          }
        }
      }

      this._setStatus(`Loaded session.frm.txt (${this._frmData.session?.title || 'untitled'})`);
      return true;
    } catch (err) {
      console.warn('Could not load session.frm.txt:', err.message);
      return false;
    }
  }

  // ── iXML read/write ────────────────────────────────────────────────────

  /**
   * Load iXML metadata from WAV files in a folder.
   * Reads the first file that has an iXML chunk with <BWFXML>.
   */
  async _loadIXMLFromFolder(folderPath) {
    try {
      const result = await window.electronAPI.readIXMLFromFolder(folderPath);
      if (!result || !result.xml) return false;
      return this._processLoadedIXML(result.xml, result.filePath);
    } catch (err) {
      console.warn('Could not load iXML from folder:', err.message);
      return false;
    }
  }

  /**
   * Load iXML metadata from a single WAV file.
   */
  async _loadIXMLFromFile(filePath) {
    try {
      const xml = await window.electronAPI.readIXML(filePath);
      if (!xml || !xml.includes('<BWFXML')) return false;
      return this._processLoadedIXML(xml, filePath);
    } catch (err) {
      console.warn('Could not load iXML:', err.message);
      return false;
    }
  }

  /**
   * Process a loaded iXML string: parse it, convert to form data,
   * load annotations, update state.
   */
  _processLoadedIXML(xmlStr, sourceFilePath) {
    const ixmlMeta = parseIXML(xmlStr);
    // Only consider it "loaded" if it has meaningful user-added content
    // (beyond what the recorder writes automatically like SPEED/TRACK_LIST)
    const hasMeaningfulData = ixmlMeta.note || ixmlMeta.project || ixmlMeta.scene ||
      ixmlMeta.user_text || (ixmlMeta.annotations && ixmlMeta.annotations.length > 0) ||
      ixmlMeta.location;
    if (!hasMeaningfulData) return false;

    this._frmData = ixmlToFormData(ixmlMeta);
    this._frmLoaded = true;
    this._ixmlSource = 'ixml';

    // Load annotations from SYNC_POINTs
    if (ixmlMeta.annotations && ixmlMeta.annotations.length > 0) {
      const appAnns = syncPointsToAnnotations(ixmlMeta.annotations);
      if (appAnns.length > 0) {
        this.annotations = appAnns;
        this._updateAnnotationsList();
        this.spectrogram.annotations = this.annotations;
        if (!this.annotationsSidebar.classList.contains('open')) {
          this._toggleAnnotationsSidebar();
        }
      }
    }

    const title = ixmlMeta.scene || ixmlMeta.project || '';
    const fname = sourceFilePath.split(/[/\\]/).pop();
    this._setStatus(`Loaded iXML metadata from ${fname}${title ? ' — ' + title : ''}`);
    return true;
  }

  /**
   * Build iXML from the current form data and save to all WAV files in the session folder.
   */
  async _saveIXMLToFolder() {
    if (!this._sessionFolderPath) {
      this._setStatus('No session folder — use "Save to File..." instead');
      return;
    }

    const formData = this._readFRMForm();
    const ixmlMeta = formDataToIXML(formData, this.session, this.annotations);
    const xml = buildIXML(ixmlMeta);

    this._setStatus('Writing iXML to WAV files...');
    try {
      const results = await window.electronAPI.writeIXMLToFolder(this._sessionFolderPath, xml);
      const ok = results.filter(r => r.success).length;
      const fail = results.filter(r => !r.success).length;
      this._frmData = formData;
      this._frmLoaded = true;
      this._ixmlSource = 'ixml';
      document.getElementById('frm-status').textContent = 'Saved to WAV files';
      this._setStatus(`iXML written to ${ok} WAV file${ok !== 1 ? 's' : ''}${fail > 0 ? ` (${fail} failed)` : ''}`);
    } catch (err) {
      this._setStatus(`Error writing iXML: ${err.message}`);
    }
  }

  /**
   * Build iXML and save to the currently open WAV file (first file in session).
   */
  async _saveIXMLToFile() {
    if (!this.session || this.session.files.length === 0) {
      this._setStatus('No file open');
      return;
    }

    const filePath = this.session.files[0].filePath;
    const formData = this._readFRMForm();
    const ixmlMeta = formDataToIXML(formData, this.session, this.annotations);
    const xml = buildIXML(ixmlMeta);

    try {
      await window.electronAPI.writeIXML(filePath, xml);
      this._frmData = formData;
      this._frmLoaded = true;
      this._ixmlSource = 'ixml';
      const fname = filePath.split(/[/\\]/).pop();
      document.getElementById('frm-status').textContent = `Saved to ${fname}`;
      this._setStatus(`iXML written to ${fname}`);
    } catch (err) {
      this._setStatus(`Error writing iXML: ${err.message}`);
    }
  }
}


document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
