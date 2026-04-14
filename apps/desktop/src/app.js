/**
 * Main application - wires session, spectrogram, and audio engine together.
 */

import { BWFParser } from './bwf-parser.js';
import { SpectrogramRenderer } from './spectrogram.js';
import { AudioEngine } from './audio-engine.js';
import { Session } from './session.js';
import { parseFRM, serializeFRM, autoPopulateFromSession, annotationsToFRM, annotationsFromFRM } from './frm.js';
import { buildIXML, parseIXML, formDataToIXML, ixmlToFormData, syncPointsToAnnotations } from './ixml.js';
import { LiveCapture } from './live-capture.js';

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.spectrogram = null;
    this.session = null;
    this._liveCapture = null;
    this._liveRecordingBlob = null;

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
    this.fftWindowSelect = document.getElementById('fft-window');
    this.minFreqInput = document.getElementById('min-freq');
    this.maxFreqInput = document.getElementById('max-freq');
    this.freqPresetSelect = document.getElementById('freq-preset');
    this.logFreqCheckbox = document.getElementById('log-freq');
    this.colorPresetSelect = document.getElementById('color-preset');
    this.channelSelect = document.getElementById('channel-select');
    this.channelControl = document.getElementById('channel-control');
    this._bigVURows = [];
    this._bigVUVisible = true;
    this._peakHoldDuration = 1500;
    this._peakDecayRate = 15;
    this.fileListPanel = document.getElementById('file-list-panel');
    this.fileListBody = document.getElementById('file-list-body');
    this.playbackFormatDisplay = document.getElementById('playback-format');
    this.dateInput = document.getElementById('date-input');
    this.dateLabel = document.getElementById('date-label');
    this.tcOffsetSelect = document.getElementById('tc-offset');
    this._tcOffsetHours = 0;

    // Spectrum analyser
    this._spectrumRAF = null;
    this._spectrumSavedLines = [];
    this._spectrumColors = [
      '#5B9BD5', '#8B5CF6', '#D946EF', '#06B6D4',
      '#F59E0B', '#10B981', '#EF4444', '#F97316',
    ];
    this._spectrumFreqMin = 20;
    this._spectrumFreqMax = null;
    this._spectrumFullscreen = false;
    this._sidebarWidth = 420;

    // Annotations
    this.annotations = [];
    this.annotationDialog = document.getElementById('annotation-dialog');
    this.annotationTimeInfo = document.getElementById('annotation-time-info');
    this.annotationNoteInput = document.getElementById('annotation-note');
    this.annotationsSidebar = document.getElementById('app-sidebar');
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
    this._openedAsFolder = false; // true only when user opened a folder
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

    // Waveform overview / minimap
    const overviewEl = document.getElementById('overview-canvas');
    if (overviewEl) this.spectrogram.setOverviewCanvas(overviewEl);

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

    // Live input
    document.getElementById('btn-live-input').addEventListener('click', () => {
      if (this._liveCapture && this._liveCapture.isCapturing) {
        this._stopLive();
      } else {
        this._startLive();
      }
    });
    document.getElementById('btn-live-record').addEventListener('click', () => this._toggleLiveRecord());
    document.getElementById('btn-live-save').addEventListener('click', () => this._saveLiveRecording());
    document.getElementById('select-input-device').addEventListener('change', (e) => {
      if (this._liveCapture && this._liveCapture.isCapturing) {
        this._startLive(e.target.value);
      }
    });
    document.getElementById('select-live-window').addEventListener('change', (e) => {
      this.spectrogram._liveViewSeconds = parseInt(e.target.value);
      this.spectrogram._liveColCache = null; // force full redraw
      this.spectrogram._liveLastCol = 0;
    });

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
      const lo = this.spectrogram.trimStart != null ? this.spectrogram.trimStart : 0;
      const hi = this.spectrogram.trimEnd != null ? this.spectrogram.trimEnd : this.spectrogram.totalDuration;
      this.spectrogram.setView(lo, hi);
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
      const db = parseFloat(e.target.value);
      this.engine.setGainDB(db);
      this.spectrogram.inputGainDB = db;
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

    this.fftWindowSelect.addEventListener('change', (e) => {
      this.spectrogram.windowType = e.target.value;
      this.spectrogram._window = null; // force window rebuild
      this.spectrogram.tileCache.clear();
      this.spectrogram._lastFFTData = null;
      this.spectrogram._lastFFTDataSplit = null;
      this.spectrogram._computing = false;
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

    document.getElementById('btn-vu').addEventListener('click', () => {
      this._toggleBigVU();
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

    document.getElementById('btn-trim-selection').addEventListener('click', () => {
      this._trimSelection();
    });
    document.getElementById('btn-untrim').addEventListener('click', () => {
      this._untrimSession();
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
      if (this._spectrumFullscreen) {
        this._spectrumFullscreen = false;
        this.annotationsSidebar.classList.remove('spectrum-fullscreen');
      }
      this._stopSpectrumAnalyser();
      this._resizeCanvas();
      setTimeout(() => this._resizeCanvas(), 220);
    });

    // Tab switching
    this.annotationsSidebar.querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        if (tab.dataset.tab) this._switchSidebarTab(tab.dataset.tab);
      });
    });

    // Spectrum analyser controls
    document.getElementById('btn-spectrum').addEventListener('click', () => this._toggleSidebar('spectrum'));
    document.getElementById('btn-spectrum-save').addEventListener('click', () => this._saveSpectrumLine());
    document.getElementById('btn-spectrum-clear').addEventListener('click', () => this._clearSpectrumLines());
    document.getElementById('btn-spectrum-export').addEventListener('click', () => this._exportSpectrumPNG());
    document.getElementById('btn-spectrum-fullscreen').addEventListener('click', () => this._toggleSpectrumFullscreen());
    document.getElementById('btn-export-png').addEventListener('click', () => this._exportSpectrogramPNG());

    const freqMinInput = document.getElementById('spectrum-freq-min');
    const freqMaxInput = document.getElementById('spectrum-freq-max');
    freqMinInput.addEventListener('change', () => {
      const v = parseInt(freqMinInput.value, 10);
      if (v > 0) this._spectrumFreqMin = v;
    });
    freqMaxInput.addEventListener('change', () => {
      const v = parseInt(freqMaxInput.value, 10);
      this._spectrumFreqMax = v > 0 ? v : null;
    });

    this._initSidebarResize();

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
        case 'KeyT':
          e.preventDefault();
          this._trimSelection();
          break;
        case 'KeyU':
          e.preventDefault();
          if (this.spectrogram.trimStart != null) this._untrimSession();
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
        this._setStatus('Only WAV files are supported — please convert your audio to WAV format');
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
        this._openedAsFolder = false;
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
          this._openedAsFolder = false;
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
      this._openedAsFolder = true;
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
      this._openedAsFolder = false;
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
    // Reset metadata state (preserve _openedAsFolder — set before _initSession)
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
    // Auto-switch to Hann for file analysis (best frequency resolution)
    this.spectrogram.windowType = 'hann';
    this.fftWindowSelect.value = 'hann';
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

    // Set up per-channel VU meter
    this.engine.setupChannelAnalysers(session.channels);
    this._buildBigVUMeter(session.channels);

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

    // Show file-dependent toolbar buttons
    document.getElementById('btn-export-png').style.display = '';

    // Compute waveform overview in background
    this.spectrogram.computeOverview();

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


  _buildBigVUMeter(numChannels) {
    const container = document.getElementById('vu-meter-big');
    container.innerHTML = '';
    this._bigVURows = [];

    const labels = ['L', 'R', 'C', 'LFE', 'LS', 'RS'];

    for (let i = 0; i < numChannels; i++) {
      const row = document.createElement('div');
      row.className = 'vu-channel-row';

      const label = document.createElement('span');
      label.className = 'vu-channel-label';
      label.textContent = numChannels === 1 ? 'M' : (labels[i] || `${i + 1}`);
      row.appendChild(label);

      const track = document.createElement('div');
      track.className = 'vu-channel-track';

      const cover = document.createElement('div');
      cover.className = 'vu-channel-cover';
      cover.style.width = '100%';
      track.appendChild(cover);

      const peakBar = document.createElement('div');
      peakBar.className = 'vu-channel-peak';
      peakBar.style.left = '0%';
      track.appendChild(peakBar);

      row.appendChild(track);

      const dbLabel = document.createElement('span');
      dbLabel.className = 'vu-channel-db';
      dbLabel.innerHTML = '<span class="vu-db-rms">\u2013\u221E</span> / <span class="vu-db-peak">\u2013\u221E</span>';
      row.appendChild(dbLabel);

      container.appendChild(row);
      this._bigVURows.push({
        cover, peakBar, track, dbLabel,
        peakHoldDb: -100,
        peakHoldTime: 0,
      });
    }

    // dBFS scale row
    const scaleRow = document.createElement('div');
    scaleRow.className = 'vu-scale-row';

    const scaleSpacer = document.createElement('span');
    scaleSpacer.className = 'vu-scale-spacer';
    scaleRow.appendChild(scaleSpacer);

    const scaleTrack = document.createElement('div');
    scaleTrack.className = 'vu-scale-track';

    const marks = [-60, -48, -36, -24, -12, -6, -3, 0];
    for (const db of marks) {
      const mark = document.createElement('span');
      mark.className = 'vu-scale-mark';
      mark.style.left = ((db + 60) / 60 * 100) + '%';
      mark.textContent = db === 0 ? '0' : String(db);
      scaleTrack.appendChild(mark);
    }
    scaleRow.appendChild(scaleTrack);

    const dbSpacer = document.createElement('span');
    dbSpacer.className = 'vu-scale-db-spacer';
    dbSpacer.textContent = 'RMS / Peak';
    scaleRow.appendChild(dbSpacer);

    container.appendChild(scaleRow);

    container.style.display = this._bigVUVisible ? 'flex' : 'none';
    this._updateVUButton();
  }

  _updateVUButton() {
    const btn = document.getElementById('btn-vu');
    if (!btn) return;
    if (this._bigVUVisible) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }

  _toggleBigVU() {
    this._bigVUVisible = !this._bigVUVisible;
    document.getElementById('vu-meter-big').style.display =
      this._bigVUVisible ? 'flex' : 'none';
    this._updateVUButton();
  }

  _startVUMeter() {
    if (this._vuRafId) cancelAnimationFrame(this._vuRafId);

    let lastTime = performance.now();
    let lastTextUpdate = 0;
    let wasPlaying = false;

    const update = (now) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      if (this.engine.isPlaying) {
        wasPlaying = true;
        const bigRows = this._bigVURows;

        if (bigRows.length > 0 && this._bigVUVisible) {
          const channels = this.engine.getChannelLevels();
          const updateText = (now - lastTextUpdate) > 150;
          if (updateText) lastTextUpdate = now;

          for (let i = 0; i < bigRows.length && i < channels.length; i++) {
            const ch = channels[i];
            const r = bigRows[i];

            const barW = Math.max(0, Math.min(100, (ch.peak + 60) / 60 * 100));
            r.cover.style.width = (100 - barW) + '%';

            if (ch.peak >= r.peakHoldDb) {
              r.peakHoldDb = ch.peak;
              r.peakHoldTime = now;
            } else if (now - r.peakHoldTime > this._peakHoldDuration) {
              r.peakHoldDb -= this._peakDecayRate * dt;
              if (r.peakHoldDb < -100) r.peakHoldDb = -100;
            }

            const peakW = Math.max(0, Math.min(100, (r.peakHoldDb + 60) / 60 * 100));
            r.peakBar.style.left = peakW + '%';

            if (ch.peak >= -0.1) {
              r.track.classList.add('vu-channel-clip');
            } else {
              r.track.classList.remove('vu-channel-clip');
            }

            if (updateText) {
              const peakText = r.peakHoldDb <= -100 ? ' \u2013\u221E' : `${r.peakHoldDb.toFixed(1)}`;
              const rmsText = ch.rms <= -100 ? ' \u2013\u221E' : `${ch.rms.toFixed(1)}`;
              r.dbLabel.innerHTML =
                `<span class="vu-db-rms">${rmsText}</span> / <span class="vu-db-peak">${peakText}</span>`;
            }
          }
        }
      } else if (wasPlaying) {
        wasPlaying = false;
        this._stopVUMeter();
      }

      this._vuRafId = requestAnimationFrame(update);
    };
    this._vuRafId = requestAnimationFrame(update);
  }

  _stopVUMeter() {
    for (const row of this._bigVURows) {
      row.cover.style.width = '100%';
      row.peakBar.style.left = '0%';
      row.track.classList.remove('vu-channel-clip');
      row.peakHoldDb = -100;
      row.peakHoldTime = 0;
      row.dbLabel.innerHTML = '<span class="vu-db-rms">\u2013\u221E</span> / <span class="vu-db-peak">\u2013\u221E</span>';
    }
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
    document.getElementById('btn-export-selection').style.display = '';
    document.getElementById('btn-trim-selection').style.display = '';
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
    document.getElementById('btn-export-selection').style.display = 'none';
    document.getElementById('btn-trim-selection').style.display = 'none';
    document.getElementById('btn-export-slowed').style.display = 'none';
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

    // Match two numbers with optional N/S/E/W direction letters.
    // Direction must be word-boundary-adjacent to avoid matching 'E' in exponents.
    const re = /\b([NSEW])?\s*(-?\d+\.?\d*)\s*([NSEW])?\b[\s,]+\b([NSEW])?\s*(-?\d+\.?\d*)\s*([NSEW])?\b/i;
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
    script += '# Auto-generated by Sound Explorer\n';
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

  /**
   * Trim: crop the loaded session to the current selection.
   * Navigation, zoom-fit, and export are constrained to the trim region.
   * Original files are never modified. Use Untrim to restore full view.
   */
  _trimSelection() {
    if (!this._pendingSelection || !this.session) return;
    const start = Math.min(this._pendingSelection.start, this._pendingSelection.end);
    const end = Math.max(this._pendingSelection.start, this._pendingSelection.end);
    if (end - start < 0.01) return;

    this.spectrogram.trimStart = start;
    this.spectrogram.trimEnd = end;

    // Clear selection and zoom to trimmed region
    this.spectrogram.selectionStart = null;
    this.spectrogram.selectionEnd = null;
    this._pendingSelection = null;
    this.selectionActions.style.display = 'none';

    this.spectrogram.setView(start, end);
    this.spectrogram.computeVisible();

    // Show untrim button, update duration display
    this._updateTrimUI();

    const dur = end - start;
    const durStr = dur >= 60 ? `${Math.floor(dur / 60)}m${Math.floor(dur % 60)}s` : `${dur.toFixed(1)}s`;
    this._setStatus(`Trimmed to ${durStr} — use Export WAV to save. Press U or click Untrim to restore.`);
  }

  /**
   * Untrim: restore full session view, remove trim bounds.
   */
  _untrimSession() {
    this.spectrogram.trimStart = null;
    this.spectrogram.trimEnd = null;
    this.spectrogram.setView(0, Math.min(120, this.spectrogram.totalDuration));
    this.spectrogram.computeVisible();
    this._updateTrimUI();
    this._setStatus('Trim removed — full session restored');
  }

  /**
   * Update UI elements that reflect trim state.
   */
  _updateTrimUI() {
    const isTrimmed = this.spectrogram.trimStart != null;
    const untrimBtn = document.getElementById('btn-untrim');
    if (untrimBtn) {
      untrimBtn.style.display = isTrimmed ? '' : 'none';
    }
    // Update duration display to show trimmed duration
    if (isTrimmed) {
      const dur = this.spectrogram.trimEnd - this.spectrogram.trimStart;
      this.durationDisplay.textContent = this._formatTime(dur) + ' (trimmed)';
    } else if (this.session) {
      this.durationDisplay.textContent = this._formatTime(this.session.totalDuration);
    }
  }

  async _exportSelectionAsWav() {
    if (!this.session) return;
    // Use selection if available, fall back to trim bounds
    let start, end;
    if (this._pendingSelection) {
      start = this._pendingSelection.start;
      end = this._pendingSelection.end;
    } else if (this.spectrogram.trimStart != null) {
      start = this.spectrogram.trimStart;
      end = this.spectrogram.trimEnd;
    } else {
      return;
    }
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
      originator: bext.originator || 'Sound Explorer',
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
    const speeds = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4];

    for (const speed of speeds) {
      const interpretedRate = Math.round(nativeSampleRate * speed);
      const el = document.createElement('option');
      el.value = speed.toString();
      let rateStr;
      if (interpretedRate >= 1000) {
        const kHz = interpretedRate / 1000;
        rateStr = `${kHz % 1 === 0 ? kHz.toFixed(0) : kHz.toFixed(1)}kHz`;
      } else {
        rateStr = `${interpretedRate}Hz`;
      }
      if (speed === 1) {
        el.textContent = `${rateStr} (Original)`;
      } else if (speed < 1) {
        const factor = Math.round(1 / speed);
        el.textContent = `${rateStr} (${factor}x slower)`;
      } else {
        el.textContent = `${rateStr} (${speed}x faster)`;
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

  // ── Tabbed sidebar ──────────────────────────────────────────────

  _toggleAnnotationsSidebar() {
    this._toggleSidebar('annotations');
  }

  _toggleSidebar(tab) {
    const sidebar = this.annotationsSidebar;
    const isOpen = sidebar.classList.contains('open');
    const currentTab = sidebar.querySelector('.sidebar-tab.active')?.dataset.tab;

    if (isOpen && currentTab === tab) {
      // Close sidebar
      sidebar.classList.remove('open');
      if (this._spectrumFullscreen) {
        this._spectrumFullscreen = false;
        sidebar.classList.remove('spectrum-fullscreen');
      }
      this._stopSpectrumAnalyser();
    } else {
      // Open sidebar and switch to requested tab
      sidebar.classList.add('open');
      if (this._sidebarWidth !== 420) {
        sidebar.style.width = this._sidebarWidth + 'px';
        sidebar.style.minWidth = this._sidebarWidth + 'px';
      }
      this._switchSidebarTab(tab);
    }
    this._resizeCanvas();
    setTimeout(() => this._resizeCanvas(), 220);
  }

  _switchSidebarTab(tab) {
    const sidebar = this.annotationsSidebar;
    sidebar.querySelectorAll('.sidebar-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    sidebar.querySelectorAll('.sidebar-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.tab === tab);
    });
    if (tab === 'spectrum') {
      this._startSpectrumAnalyser();
    } else {
      this._stopSpectrumAnalyser();
      if (this._spectrumFullscreen) {
        this._spectrumFullscreen = false;
        sidebar.classList.remove('spectrum-fullscreen');
      }
    }
  }

  // ── Spectrum Analyser ────��────────────────────────────────────────

  static _hexToRgba(hex, a) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  static _drawSpectrumLine(ctx, data, binCount, sr, color, alpha, fill, freqToX, dbToY, dbMin, freqMin, freqMax) {
    const binHz = sr / (binCount * 2);
    ctx.beginPath();
    let started = false;
    for (let i = 1; i < binCount; i++) {
      const f = i * binHz;
      if (f < freqMin || f > freqMax) continue;
      const x = freqToX(f);
      const db = Math.max(dbMin, data[i]);
      const y = dbToY(db);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    if (fill && started) {
      ctx.lineTo(freqToX(freqMax), dbToY(dbMin));
      ctx.lineTo(freqToX(freqMin), dbToY(dbMin));
      ctx.closePath();
      ctx.fillStyle = App._hexToRgba(color, alpha * 0.15);
      ctx.fill();
    }
    ctx.strokeStyle = App._hexToRgba(color, alpha);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _formatHMS(sec) {
    const s = ((sec % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }

  _startSpectrumAnalyser() {
    if (this._spectrumRAF) return;
    const canvas = document.getElementById('spectrum-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const draw = () => {
      this._spectrumRAF = requestAnimationFrame(draw);

      let spec = null;
      if (this._liveCapture && this._liveCapture.isCapturing) {
        spec = this._liveCapture.getSpectrumData();
      } else if (this.engine && this.engine.spectrumAnalyser) {
        spec = this.engine.getSpectrumData();
      }

      // Skip redraw when idle (no live data and no saved lines)
      if (!spec && this._spectrumSavedLines.length === 0) return;

      const wrap = canvas.parentElement;
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const pad = { top: 8, right: 8, bottom: 20, left: 36 };
      const pw = w - pad.left - pad.right;
      const ph = h - pad.top - pad.bottom;
      ctx.clearRect(0, 0, w, h);

      const dbMin = -120, dbMax = 0;
      const sampleRate = spec ? spec.sampleRate : (this.session?.sampleRate || 48000);
      const nyquist = sampleRate / 2;
      const freqMin = Math.max(1, this._spectrumFreqMin || 20);
      const freqMax = Math.min(nyquist, this._spectrumFreqMax || nyquist);
      const logMin = Math.log10(freqMin);
      const logMax = Math.log10(freqMax);

      const freqToX = (f) => pad.left + ((Math.log10(f) - logMin) / (logMax - logMin)) * pw;
      const dbToY = (db) => pad.top + ((dbMax - db) / (dbMax - dbMin)) * ph;

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.3)';

      const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
      for (const f of freqTicks) {
        if (f < freqMin || f > freqMax) continue;
        const x = freqToX(f);
        ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
        const label = f >= 1000 ? (f / 1000) + 'k' : String(f);
        ctx.fillText(label, x, pad.top + ph + 4);
      }

      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let db = dbMin; db <= dbMax; db += 20) {
        const y = dbToY(db);
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
        ctx.fillText(db + '', pad.left - 4, y);
      }

      for (const line of this._spectrumSavedLines) {
        App._drawSpectrumLine(ctx, line.data, line.binCount, line.sampleRate, line.color, 0.6, true, freqToX, dbToY, dbMin, freqMin, freqMax);
      }

      if (spec && spec.data) {
        App._drawSpectrumLine(ctx, spec.data, spec.binCount, spec.sampleRate, '#ffffff', 1, false, freqToX, dbToY, dbMin, freqMin, freqMax);
      }
    };

    this._spectrumRAF = requestAnimationFrame(draw);
  }

  _stopSpectrumAnalyser() {
    if (this._spectrumRAF) {
      cancelAnimationFrame(this._spectrumRAF);
      this._spectrumRAF = null;
    }
  }

  _saveSpectrumLine() {
    let spec = null;
    if (this._liveCapture && this._liveCapture.isCapturing) {
      spec = this._liveCapture.getSpectrumData();
    } else if (this.engine) {
      spec = this.engine.getSpectrumData();
    }
    if (!spec || !spec.data) {
      this.statusDisplay.textContent = 'No spectrum data — play audio or start live input';
      return;
    }

    const idx = this._spectrumSavedLines.length;
    const color = this._spectrumColors[idx % this._spectrumColors.length];
    this._spectrumSavedLines.push({
      data: new Float32Array(spec.data),
      binCount: spec.binCount,
      sampleRate: spec.sampleRate,
      color,
      label: `Capture ${idx + 1}`,
    });
    this._renderSpectrumLinesList();
  }

  _clearSpectrumLines() {
    this._spectrumSavedLines = [];
    this._renderSpectrumLinesList();
  }

  _deleteSpectrumLine(idx) {
    this._spectrumSavedLines.splice(idx, 1);
    this._renderSpectrumLinesList();
  }

  _renderSpectrumLinesList() {
    const list = document.getElementById('spectrum-lines-list');
    if (!list) return;
    list.innerHTML = '';
    this._spectrumSavedLines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'spectrum-line-item';

      const swatch = document.createElement('div');
      swatch.className = 'spectrum-line-swatch';
      swatch.style.background = line.color;

      const label = document.createElement('input');
      label.className = 'spectrum-line-label';
      label.type = 'text';
      label.value = line.label;
      label.addEventListener('change', () => { line.label = label.value; });

      const del = document.createElement('button');
      del.className = 'spectrum-line-del';
      del.textContent = '\u00D7';
      del.addEventListener('click', () => this._deleteSpectrumLine(i));

      row.appendChild(swatch);
      row.appendChild(label);
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  _initSidebarResize() {
    const sidebar = this.annotationsSidebar;
    const handle = document.createElement('div');
    handle.className = 'sidebar-resize-handle';
    sidebar.prepend(handle);

    let startX, startW;
    const onMove = (e) => {
      const clientX = e.clientX;
      const delta = startX - clientX;
      const newW = Math.max(200, Math.min(window.innerWidth * 0.8, startW + delta));
      sidebar.style.width = newW + 'px';
      sidebar.style.minWidth = newW + 'px';
      this._sidebarWidth = newW;
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this._resizeCanvas();
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _toggleSpectrumFullscreen() {
    const sidebar = this.annotationsSidebar;
    this._spectrumFullscreen = !this._spectrumFullscreen;
    sidebar.classList.toggle('spectrum-fullscreen', this._spectrumFullscreen);

    const btn = document.getElementById('btn-spectrum-fullscreen');
    btn.title = this._spectrumFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen';
    btn.textContent = this._spectrumFullscreen ? '\u2716' : '\u26F6';

    if (!this._spectrumFullscreen) {
      this._resizeCanvas();
    }
  }

  _exportSpectrumPNG() {
    const sampleRate = this._liveCapture?.isCapturing
      ? this._liveCapture.sampleRate
      : (this.session?.sampleRate || 48000);
    const nyquist = sampleRate / 2;
    const freqMin = Math.max(1, this._spectrumFreqMin || 20);
    const freqMax = Math.min(nyquist, this._spectrumFreqMax || nyquist);
    const dbMin = -120, dbMax = 0;
    const logMin = Math.log10(freqMin);
    const logMax = Math.log10(freqMax);

    const lines = this._spectrumSavedLines;
    let liveSpec = null;
    if (this._liveCapture?.isCapturing) liveSpec = this._liveCapture.getSpectrumData();
    else if (this.engine) liveSpec = this.engine.getSpectrumData();
    const hasLive = !!(liveSpec?.data);
    const legendItems = lines.length + (hasLive ? 1 : 0);
    const hasLegend = legendItems > 0;

    const scale = 2;
    const pad = { top: 24, right: 20, bottom: 36, left: 52 };
    const plotW = 800, plotH = 400;
    const legendLineH = 22, legendPad = 12;
    const legendH = hasLegend ? legendPad + legendItems * legendLineH + legendPad : 0;
    const brandH = 28;
    const totalW = pad.left + plotW + pad.right;
    const totalH = pad.top + plotH + pad.bottom + legendH + brandH;

    const exp = document.createElement('canvas');
    exp.width = totalW * scale;
    exp.height = totalH * scale;
    const ctx = exp.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, totalW, totalH);

    const freqToX = (f) => pad.left + ((Math.log10(f) - logMin) / (logMax - logMin)) * plotW;
    const dbToY = (db) => pad.top + ((dbMax - db) / (dbMax - dbMin)) * plotH;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(pad.left, pad.top, plotW, plotH);

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';

    const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of freqTicks) {
      if (f < freqMin || f > freqMax) continue;
      const x = freqToX(f);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + plotH); ctx.stroke();
      ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x, pad.top + plotH + 5);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('Frequency (Hz)', pad.left + plotW / 2, pad.top + plotH + 20);

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let db = dbMin; db <= dbMax; db += 20) {
      const y = dbToY(db);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + plotW, y); ctx.stroke();
      ctx.fillText(db + ' dB', pad.left - 5, y);
    }

    for (const line of lines) App._drawSpectrumLine(ctx, line.data, line.binCount, line.sampleRate, line.color, 0.7, true, freqToX, dbToY, dbMin, freqMin, freqMax);
    if (hasLive) App._drawSpectrumLine(ctx, liveSpec.data, liveSpec.binCount, liveSpec.sampleRate, '#ffffff', 1, false, freqToX, dbToY, dbMin, freqMin, freqMax);

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    if (hasLegend) {
      const ly = pad.top + plotH + pad.bottom;
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.beginPath(); ctx.moveTo(pad.left, ly); ctx.lineTo(pad.left + plotW, ly); ctx.stroke();
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      lines.forEach((line, i) => {
        const y = ly + legendPad + i * legendLineH + legendLineH / 2;
        ctx.fillStyle = line.color;
        ctx.fillRect(pad.left, y - 6, 14, 12);
        ctx.fillStyle = '#ccc';
        ctx.fillText(line.label, pad.left + 22, y);
      });
      if (hasLive) {
        const y = ly + legendPad + lines.length * legendLineH + legendLineH / 2;
        ctx.fillStyle = '#fff';
        ctx.fillRect(pad.left, y - 6, 14, 12);
        ctx.fillStyle = '#ccc';
        ctx.fillText('Live', pad.left + 22, y);
      }
    }

    const by = totalH - brandH;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, by, totalW, brandH);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('\u223F Sound Explorer', pad.left, by + brandH / 2);
    ctx.textAlign = 'right';
    const dateStr = new Date().toISOString().slice(0, 10);
    ctx.fillText(`${sampleRate} Hz \u00B7 ${dateStr}`, pad.left + plotW, by + brandH / 2);

    exp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'spectrum.png';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  _exportSpectrogramPNG() {
    if (!this.spectrogram || !this.session) return;
    const sg = this.spectrogram;
    if (!sg._spectBitmap) {
      this.statusDisplay.textContent = 'No spectrogram to export';
      return;
    }

    const scale = 2;
    const hasWallClock = this.session.sessionStartTime !== null;
    const marginL = 60, marginT = 10, marginR = 10;
    const marginB = hasWallClock ? 66 : 50;
    const brandH = 28;
    const plotW = this.canvas.width - 50;
    const plotH = this.canvas.height - 40; // desktop uses fixed 40px bottom axis
    const totalW = marginL + plotW + marginR;
    const totalH = marginT + plotH + marginB + brandH;

    const exp = document.createElement('canvas');
    exp.width = totalW * scale;
    exp.height = totalH * scale;
    const ctx = exp.getContext('2d');
    ctx.scale(scale, scale);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, totalW, totalH);
    ctx.drawImage(sg._spectBitmap, marginL, marginT, plotW, plotH);

    const viewDuration = sg.viewEnd - sg.viewStart;
    const timeStart = sg.viewStart;
    ctx.fillStyle = '#999';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const numTimeTicks = Math.max(2, Math.floor(plotW / 100));
    for (let i = 0; i <= numTimeTicks; i++) {
      const t = timeStart + (i / numTimeTicks) * viewDuration;
      const x = marginL + (i / numTimeTicks) * plotW;
      ctx.beginPath(); ctx.moveTo(x, marginT + plotH); ctx.lineTo(x, marginT + plotH + 5); ctx.stroke();
      ctx.fillText(sg._formatDuration(t), x, marginT + plotH + 8);

      if (hasWallClock) {
        const wallSec = this.session.toWallClock(t);
        if (wallSec !== null) {
          ctx.fillStyle = '#7a9ec2';
          ctx.font = '9px monospace';
          ctx.fillText(this._formatHMS(wallSec), x, marginT + plotH + 22);
          ctx.fillStyle = '#999';
          ctx.font = '10px monospace';
        }
      }
    }
    const timeLabelY = hasWallClock ? marginT + plotH + 40 : marginT + plotH + 28;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(hasWallClock ? 'Time / Wall Clock' : 'Time', marginL + plotW / 2, timeLabelY);

    ctx.fillStyle = '#999';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const numFreqTicks = Math.max(2, Math.floor(plotH / 60));
    for (let i = 0; i <= numFreqTicks; i++) {
      const frac = i / numFreqTicks;
      let freq;
      if (sg.logFrequency && sg.minFreq > 0) {
        const logMin = Math.log10(sg.minFreq);
        const logMax = Math.log10(sg.maxFreq);
        freq = Math.pow(10, logMin + frac * (logMax - logMin));
      } else {
        freq = sg.minFreq + frac * (sg.maxFreq - sg.minFreq);
      }
      const y = marginT + plotH - frac * plotH;
      ctx.strokeStyle = '#555';
      ctx.beginPath(); ctx.moveTo(marginL - 5, y); ctx.lineTo(marginL, y); ctx.stroke();
      let label;
      if (freq >= 1000) label = (freq / 1000).toFixed(freq >= 10000 ? 0 : 1) + 'k';
      else label = Math.round(freq).toString();
      ctx.fillText(label, marginL - 8, y);
    }

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.translate(12, marginT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Frequency (Hz)', 0, 0);
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(marginL, marginT, plotW, plotH);

    const by = totalH - brandH;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, by, totalW, brandH);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText('\u223F Sound Explorer', marginL, by + brandH / 2);

    const sr = this.session.sampleRate;
    const fftLabel = `FFT ${sg.fftSize}`;
    const windowLabel = sg.windowType;
    const rangeLabel = `${sg.minFreq}\u2013${Math.round(sg.maxFreq)} Hz`;
    const dateStr = new Date().toISOString().slice(0, 10);
    ctx.textAlign = 'right';
    ctx.fillText(`${sr} Hz \u00B7 ${fftLabel} \u00B7 ${windowLabel} \u00B7 ${rangeLabel} \u00B7 ${dateStr}`, marginL + plotW, by + brandH / 2);

    exp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const baseName = this.session?.files?.[0]?.name?.replace(/\.wav$/i, '') || 'spectrogram';
      a.download = `${baseName}_spectrogram.png`;
      a.click();
      URL.revokeObjectURL(url);
      this.statusDisplay.textContent = 'Spectrogram PNG exported';
    }, 'image/png');
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
    const saveBtn = document.getElementById('frm-save');
    const saveAsBtn = document.getElementById('frm-save-as');
    const saveIxmlBtn = document.getElementById('frm-save-ixml');
    const saveIxmlFileBtn = document.getElementById('frm-save-ixml-file');
    const openBtn = document.getElementById('btn-session-meta');

    openBtn.addEventListener('click', () => this._openFRMModal());
    saveBtn.addEventListener('click', () => this._saveFRM());
    saveAsBtn.addEventListener('click', () => this._saveFRMAs());
    saveIxmlBtn.addEventListener('click', () => this._saveIXMLToFolder());
    saveIxmlFileBtn.addEventListener('click', () => this._saveIXMLToFile());

    // Add mic button
    document.getElementById('frm-add-mic').addEventListener('click', () => {
      this._addMicRow();
    });

    // Location presets
    document.getElementById('frm-loc-preset').addEventListener('change', (e) => {
      this._applyLocationPreset(e.target.value);
    });
    document.getElementById('frm-loc-save-preset').addEventListener('click', () => {
      this._saveLocationPreset();
    });
    document.getElementById('frm-loc-del-preset').addEventListener('click', () => {
      this._deleteLocationPreset();
    });

    // Tag autocomplete
    this._setupTagAutocomplete();
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

    // Apply sticky defaults to empty fields
    this._applyDefaults();

    // Populate location presets dropdown
    this._populateLocationPresets();

    this._toggleSidebar('metadata');

    let statusText = 'Auto-populated from BWF metadata';
    if (this._ixmlSource === 'ixml') statusText = 'Loaded from iXML chunk';
    else if (this._ixmlSource === 'frm') statusText = 'Loaded from session.frm.txt';
    document.getElementById('frm-status').textContent = statusText;

    // "Save to WAV(s)" — only visible when opened as a folder
    const saveIxmlBtn = document.getElementById('frm-save-ixml');
    const fileCount = this.session?.files?.length || 0;
    if (this._openedAsFolder && this._sessionFolderPath) {
      saveIxmlBtn.style.display = '';
      saveIxmlBtn.disabled = false;
      saveIxmlBtn.textContent = `Save to ${fileCount} WAV${fileCount !== 1 ? 's' : ''}`;
      saveIxmlBtn.title = `Embed iXML into all WAV files in ${this._sessionFolderPath.split(/[/\\]/).pop()}/`;
    } else {
      saveIxmlBtn.style.display = 'none';
    }

    // "Save to File" — saves to the currently open first file
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
    this._saveDefaults();
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
    // Consider it loaded if there is any meaningful content at all
    const hasMeaningfulData = ixmlMeta.note || ixmlMeta.project || ixmlMeta.scene ||
      ixmlMeta.tape || ixmlMeta.take ||
      ixmlMeta.user_text || (ixmlMeta.annotations && ixmlMeta.annotations.length > 0) ||
      ixmlMeta.location ||
      (ixmlMeta.tracks && ixmlMeta.tracks.length > 0) ||
      (ixmlMeta.speed && (ixmlMeta.speed.sample_rate || ixmlMeta.speed.bit_depth)) ||
      (ixmlMeta.user_tags && Object.keys(ixmlMeta.user_tags).length > 0) ||
      (ixmlMeta.user_data && Object.keys(ixmlMeta.user_data).length > 0) ||
      (ixmlMeta.aswg && Object.keys(ixmlMeta.aswg).length > 0);
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
      this._saveDefaults();
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
      this._saveDefaults();
      const fname = filePath.split(/[/\\]/).pop();
      document.getElementById('frm-status').textContent = `Saved to ${fname}`;
      this._setStatus(`iXML written to ${fname}`);
    } catch (err) {
      this._setStatus(`Error writing iXML: ${err.message}`);
    }
  }

  // ── Sticky defaults (localStorage) ───────────────────────────────────

  _loadDefaults() {
    try {
      return JSON.parse(localStorage.getItem('fre-defaults') || '{}');
    } catch { return {}; }
  }

  _saveDefaults() {
    const d = this._loadDefaults();
    const v = (id) => document.getElementById(id).value.trim();
    if (v('frm-recordist')) d.recordist = v('frm-recordist');
    if (v('frm-license')) d.license = v('frm-license');
    if (v('frm-dt-tz')) d.timezone = v('frm-dt-tz');
    if (v('frm-eq-model')) d.recorder_model = v('frm-eq-model');
    localStorage.setItem('fre-defaults', JSON.stringify(d));

    // Also persist tags
    this._persistTags();
  }

  _applyDefaults() {
    const d = this._loadDefaults();
    const fill = (id, val) => {
      const el = document.getElementById(id);
      if (el && !el.value.trim() && val) el.value = val;
    };
    fill('frm-recordist', d.recordist);
    fill('frm-license', d.license);
    fill('frm-dt-tz', d.timezone);
    fill('frm-eq-model', d.recorder_model);
  }

  // ── Location presets (localStorage) ──────────────────────────────────

  _loadLocationPresets() {
    try {
      return JSON.parse(localStorage.getItem('fre-locations') || '[]');
    } catch { return []; }
  }

  _populateLocationPresets() {
    const sel = document.getElementById('frm-loc-preset');
    const presets = this._loadLocationPresets();
    sel.innerHTML = '<option value="">— pick location —</option>';
    for (let i = 0; i < presets.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = presets[i].label;
      sel.appendChild(opt);
    }
  }

  _applyLocationPreset(indexStr) {
    if (indexStr === '') return;
    const presets = this._loadLocationPresets();
    const p = presets[parseInt(indexStr)];
    if (!p) return;
    document.getElementById('frm-loc-name').value = p.name || '';
    document.getElementById('frm-loc-region').value = p.region || '';
    document.getElementById('frm-loc-gps').value = p.gps || '';
    document.getElementById('frm-loc-elev').value = p.elevation || '';
    document.getElementById('frm-loc-env').value = p.environment || '';
  }

  _saveLocationPreset() {
    const name = document.getElementById('frm-loc-name').value.trim();
    const region = document.getElementById('frm-loc-region').value.trim();
    const gps = document.getElementById('frm-loc-gps').value.trim();
    if (!name && !gps) {
      this._setStatus('Fill in at least a location name or GPS before saving');
      return;
    }
    const label = window.prompt('Preset name:', name + (region ? ', ' + region : ''));
    if (!label) return;

    const preset = {
      label,
      name,
      region,
      gps,
      elevation: document.getElementById('frm-loc-elev').value.trim(),
      environment: document.getElementById('frm-loc-env').value.trim(),
    };
    const presets = this._loadLocationPresets();
    presets.push(preset);
    localStorage.setItem('fre-locations', JSON.stringify(presets));
    this._populateLocationPresets();
    // Select the newly added preset
    document.getElementById('frm-loc-preset').value = String(presets.length - 1);
    this._setStatus(`Location preset "${label}" saved`);
  }

  _deleteLocationPreset() {
    const sel = document.getElementById('frm-loc-preset');
    const idx = parseInt(sel.value);
    if (isNaN(idx)) return;
    const presets = this._loadLocationPresets();
    if (!presets[idx]) return;
    const label = presets[idx].label;
    presets.splice(idx, 1);
    localStorage.setItem('fre-locations', JSON.stringify(presets));
    this._populateLocationPresets();
    this._setStatus(`Deleted location preset "${label}"`);
  }

  // ── Tag autocomplete (localStorage) ──────────────────────────────────

  _loadTagHistory() {
    try {
      return JSON.parse(localStorage.getItem('fre-tags') || '[]');
    } catch { return []; }
  }

  _persistTags() {
    const tagsStr = document.getElementById('frm-tags').value.trim();
    if (!tagsStr) return;
    const newTags = tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const history = this._loadTagHistory();
    // Prepend new tags, dedupe, cap at 200
    const set = new Set(newTags);
    for (const t of history) set.add(t);
    const merged = [...set].slice(0, 200);
    localStorage.setItem('fre-tags', JSON.stringify(merged));
  }

  _setupTagAutocomplete() {
    const input = document.getElementById('frm-tags');
    const container = document.getElementById('frm-tags-suggestions');
    let activeIdx = -1;

    input.addEventListener('input', () => {
      this._updateTagSuggestions();
    });

    input.addEventListener('keydown', (e) => {
      const items = container.querySelectorAll('.frm-suggestion-item');
      if (!container.classList.contains('open') || items.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        if (activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault();
          this._acceptTagSuggestion(items[activeIdx].textContent);
        }
      }
    });

    input.addEventListener('blur', () => {
      // Delay to allow click on suggestion
      setTimeout(() => {
        container.classList.remove('open');
        activeIdx = -1;
      }, 150);
    });
  }

  _updateTagSuggestions() {
    const input = document.getElementById('frm-tags');
    const container = document.getElementById('frm-tags-suggestions');
    const val = input.value;
    const lastComma = val.lastIndexOf(',');
    const current = (lastComma >= 0 ? val.slice(lastComma + 1) : val).trim().toLowerCase();

    if (current.length === 0) {
      container.classList.remove('open');
      return;
    }

    // Tags already in the input (to exclude from suggestions)
    const existing = new Set(val.split(',').map(t => t.trim().toLowerCase()).filter(Boolean));
    const history = this._loadTagHistory();
    const matches = history
      .filter(t => t.startsWith(current) && !existing.has(t))
      .slice(0, 8);

    if (matches.length === 0) {
      container.classList.remove('open');
      return;
    }

    container.innerHTML = matches.map(t =>
      `<div class="frm-suggestion-item">${this._escapeHtml(t)}</div>`
    ).join('');
    container.classList.add('open');

    container.querySelectorAll('.frm-suggestion-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this._acceptTagSuggestion(el.textContent);
      });
    });
  }

  _acceptTagSuggestion(tag) {
    const input = document.getElementById('frm-tags');
    const container = document.getElementById('frm-tags-suggestions');
    const val = input.value;
    const lastComma = val.lastIndexOf(',');
    const before = lastComma >= 0 ? val.slice(0, lastComma + 1) + ' ' : '';
    input.value = before + tag + ', ';
    container.classList.remove('open');
    input.focus();
  }

  // --- Live Input ---

  async _startLive(deviceId = null) {
    try {
      if (this._liveCapture) {
        this.spectrogram.stopLive();
        await this._liveCapture.stop();
      }

      this._liveCapture = new LiveCapture();

      // Populate input device selector
      const devices = await LiveCapture.getInputDevices();
      const sel = document.getElementById('select-input-device');
      sel.innerHTML = '';
      for (const d of devices) {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      }
      if (deviceId) sel.value = deviceId;

      await this._liveCapture.start(deviceId || sel.value || null);

      // Hide welcome overlay
      const welcome = document.getElementById('welcome');
      if (welcome) welcome.style.display = 'none';

      // Resize canvas
      this._resizeCanvas();

      // Update frequency controls
      const nyquist = this._liveCapture.sampleRate / 2;
      this.maxFreqInput.value = nyquist;
      this.minFreqInput.value = 0;
      this.spectrogram.minFreq = 0;
      this.spectrogram.maxFreq = nyquist;

      // Auto-switch to Blackman-Harris for live (best sidelobe suppression)
      this.spectrogram.windowType = 'blackman-harris';
      this.fftWindowSelect.value = 'blackman-harris';

      // Connect spectrogram to live source
      this.spectrogram.setLiveSource(this._liveCapture);

      // Show live controls, hide file controls
      document.getElementById('live-controls').style.display = '';
      const liveBtn = document.getElementById('btn-live-input');
      liveBtn.classList.add('live-active');
      liveBtn.textContent = 'Stop Live';
      document.getElementById('btn-live-record').style.display = '';
      this.btnPlay.style.display = 'none';
      this.btnStop.style.display = 'none';
      // Hide file-only toolbar controls
      for (const id of ['btn-open-folder', 'btn-open-file', 'output-samplerate',
          'btn-export-selection', 'btn-export-slowed', 'btn-export-png',
          'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit', 'btn-zoom-sel',
          'btn-trim-selection', 'btn-untrim', 'btn-annotations', 'btn-session-meta',
          'goto-mode', 'time-input', 'btn-goto', 'date-input', 'date-label']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
      // Hide toolbar groups that are file-only (separators, labels)
      document.querySelectorAll('.toolbar-primary .toolbar-separator, .toolbar-primary .time-nav, .toolbar-primary label[for="output-samplerate"]').forEach(
        el => el.style.display = 'none'
      );

      this._setStatus(`Live input: ${this._liveCapture.sampleRate} Hz`);
      this._updateLiveStatus();
    } catch (e) {
      console.error('Live input error:', e);
      if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
        this._setStatus('Microphone access denied — please allow microphone in your system settings and try again');
      } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        this._setStatus('No microphone found — please connect an audio input device');
      } else {
        this._setStatus(`Live input error: ${e.message}`);
      }
    }
  }

  async _stopLive() {
    let recordingBlob = null;
    if (this._liveCapture) {
      if (this._liveCapture.isRecording) {
        recordingBlob = this._liveCapture.stopRecording();
      }
      if (!recordingBlob) recordingBlob = this._liveRecordingBlob;

      this.spectrogram.stopLive();
      try {
        await this._liveCapture.stop();
      } catch (e) {
        console.warn('Error stopping live capture (ignored):', e);
      }
      this._liveCapture = null;
    }

    document.getElementById('live-controls').style.display = 'none';
    const liveBtn = document.getElementById('btn-live-input');
    liveBtn.classList.remove('live-active');
    liveBtn.textContent = 'Live Input';
    document.getElementById('btn-live-record').style.display = 'none';
    document.getElementById('btn-live-save').style.display = 'none';
    this.btnPlay.style.display = '';
    this.btnStop.style.display = '';
    // Restore file-only toolbar controls
    for (const id of ['btn-open-folder', 'btn-open-file', 'output-samplerate',
        'btn-export-png',
        'btn-zoom-in', 'btn-zoom-out', 'btn-zoom-fit', 'btn-zoom-sel',
        'btn-annotations', 'btn-session-meta',
        'goto-mode', 'time-input', 'btn-goto']) {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    }
    // Restore toolbar groups
    document.querySelectorAll('.toolbar-primary .toolbar-separator, .toolbar-primary .time-nav, .toolbar-primary label[for="output-samplerate"]').forEach(
      el => el.style.display = ''
    );

    // If we have a recording, save to temp and load into analysis mode
    if (recordingBlob) {
      this._liveRecordingBlob = null;
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fileName = `live-recording-${ts}.wav`;
        const arrayBuffer = await recordingBlob.arrayBuffer();
        const tempPath = await window.electronAPI.saveTempFile(fileName, new Uint8Array(arrayBuffer));
        this._setStatus('Loading recording...');
        this.session = new Session();
        await this.session.loadFile(tempPath);
        this._openedAsFolder = false;
        await this._initSession();
        return;
      } catch (e) {
        console.error('Failed to load recording:', e);
        this._setStatus('Error loading recording: ' + e.message);
      }
    }

    // Show welcome if no session
    if (!this.session) {
      const welcome = document.getElementById('welcome');
      if (welcome) welcome.style.display = '';
    }
    this._setStatus('Live input stopped');
  }

  _toggleLiveRecord() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;
    const btn = document.getElementById('btn-live-record');

    if (this._liveCapture.isRecording) {
      this._liveRecordingBlob = this._liveCapture.stopRecording();
      btn.classList.remove('recording');
      btn.id = 'btn-live-record';
      btn.innerHTML = '&#x23FA; Rec';
      if (this._liveRecordingBlob) {
        document.getElementById('btn-live-save').style.display = '';
        this._setStatus('Recording ready — click Stop Live to load for playback, or Save WAV to export');
      }
    } else {
      this._liveCapture.startRecording();
      btn.classList.add('recording');
      btn.innerHTML = '&#x23F9; Stop Rec';
      document.getElementById('btn-live-save').style.display = 'none';
      this._liveRecordingBlob = null;
    }
  }

  async _saveLiveRecording() {
    if (!this._liveRecordingBlob) return;
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filePath = await window.electronAPI.saveFileDialog({
      title: 'Save Live Recording',
      defaultPath: `live-recording-${ts}.wav`,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
    });
    if (!filePath) return;

    const arrayBuffer = await this._liveRecordingBlob.arrayBuffer();
    await window.electronAPI.writeBinaryFile(filePath, new Uint8Array(arrayBuffer));
    this._setStatus(`Recording saved: ${filePath}`);
  }

  _updateLiveStatus() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;
    const sr = this._liveCapture.sampleRate;
    const totalSec = this._liveCapture.totalSamples / sr;
    const status = document.getElementById('live-status');
    const rec = this._liveCapture.isRecording;

    // Wall clock time
    const now = new Date();
    const wallText = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

    status.textContent = `${sr} Hz | ${this._formatTime(totalSec)}${rec ? ' | REC' : ''} | ${wallText}`;

    this.fileInfoDisplay.textContent = `Live ${sr} Hz`;
    // Show wall clock in the wall-time display
    const wallTimeEl = document.getElementById('wall-time');
    if (wallTimeEl) wallTimeEl.textContent = wallText;
    this.durationDisplay.textContent = rec ? `REC ${this._formatTime(totalSec)}` : this._formatTime(totalSec);

    requestAnimationFrame(() => this._updateLiveStatus());
  }
}


document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
