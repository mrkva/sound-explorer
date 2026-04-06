/**
 * Main application controller — wires together WAV parser, spectrogram, audio engine, and UI.
 */

import { WavParser } from './wav-parser.js?v=3';
import { SpectrogramRenderer } from './spectrogram.js?v=3';
import { AudioEngine } from './audio-engine.js?v=3';

class App {
  constructor() {
    this.spectrogram = null;
    this.audio = new AudioEngine();
    this.wavInfos = [];
    this.annotations = [];
    this._vuRAF = null;
    this._settingsTimer = null;

    this._initUI();
    this._initDragDrop();
    this._initKeyboard();
    this._initAudioCallbacks();
  }

  // --- UI References ---

  _initUI() {
    // Canvas
    const canvas = document.getElementById('spectrogram-canvas');
    this.spectrogram = new SpectrogramRenderer(canvas);

    // Toolbar buttons
    document.getElementById('btn-open').addEventListener('click', () => {
      document.getElementById('file-input').click();
    });
    document.getElementById('file-input').addEventListener('change', (e) => {
      this._loadFiles(Array.from(e.target.files));
    });

    // Open button in toolbar (for opening another file)
    document.getElementById('btn-open-file').addEventListener('click', () => {
      document.getElementById('file-input-toolbar').click();
    });
    document.getElementById('file-input-toolbar').addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        this._loadFiles(Array.from(e.target.files));
        e.target.value = ''; // reset so same file can be re-selected
      }
    });

    document.getElementById('btn-play').addEventListener('click', () => this._togglePlay());
    document.getElementById('btn-stop').addEventListener('click', () => this._stop());
    document.getElementById('btn-zoom-in').addEventListener('click', () => this.spectrogram.zoomIn());
    document.getElementById('btn-zoom-out').addEventListener('click', () => this.spectrogram.zoomOut());
    document.getElementById('btn-fit').addEventListener('click', () => this.spectrogram.fitAll());

    // Go To
    document.getElementById('btn-goto').addEventListener('click', () => this._goTo());
    document.getElementById('input-goto').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._goTo();
    });
    document.getElementById('btn-goto-mode').addEventListener('click', () => this._toggleGoToMode());
    this._goToMode = 'position'; // or 'wallclock'

    // Speed selector
    document.getElementById('select-speed').addEventListener('change', async (e) => {
      const sel = e.target;
      const rate = parseFloat(sel.value);
      sel.disabled = true;
      this._setStatus('Rebuilding audio for new speed...');
      await this.audio.setPlaybackRate(rate);
      sel.disabled = false;
      this._setStatus('Ready');
      this._updateExportSpeedButton(rate);
    });

    // Selection controls
    document.getElementById('input-sel-from').addEventListener('change', (e) => this._onSelectionInput());
    document.getElementById('input-sel-to').addEventListener('change', (e) => this._onSelectionInput());
    document.getElementById('select-duration-preset').addEventListener('change', (e) => this._onDurationPreset(e.target.value));
    document.getElementById('btn-export').addEventListener('click', () => this._exportWav());
    document.getElementById('btn-export-speed').addEventListener('click', () => this._exportWavAtSpeed());
    document.getElementById('btn-loop').addEventListener('click', () => this._toggleLoop());

    // Annotations panel toggle
    document.getElementById('btn-annotations').addEventListener('click', () => this._toggleAnnotationsPanel());

    // Dark mode toggle
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') document.body.classList.add('dark');
    document.getElementById('btn-theme').addEventListener('click', () => {
      document.body.classList.toggle('dark');
      const isDark = document.body.classList.contains('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      document.getElementById('btn-theme').innerHTML = isDark ? '&#x2600;' : '&#x263E;';
    });
    if (savedTheme === 'dark') {
      document.getElementById('btn-theme').innerHTML = '&#x2600;';
    }

    // Shortcuts dialog
    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      document.getElementById('shortcuts-dialog').showModal();
    });
    document.getElementById('btn-close-shortcuts').addEventListener('click', () => {
      document.getElementById('shortcuts-dialog').close();
    });

    // Bottom bar controls
    document.getElementById('input-gain').addEventListener('input', (e) => {
      const db = parseFloat(e.target.value);
      this.audio.setGain(db);
      document.getElementById('label-gain').textContent = `${db} dB`;
    });

    document.getElementById('input-volume').addEventListener('input', (e) => {
      this.audio.setVolume(parseFloat(e.target.value));
    });

    document.getElementById('input-spec-gain').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.spectrogram.dbMax = val;
      document.getElementById('label-spec-gain').textContent = `${val} dB`;
      this._debouncedRender();
    });

    document.getElementById('input-spec-range').addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      this.spectrogram.dbMin = val;
      document.getElementById('label-spec-range').textContent = `${val} dB`;
      this._debouncedRender();
    });

    document.getElementById('select-fft').addEventListener('change', (e) => {
      this.spectrogram.fftSize = parseInt(e.target.value);
      this._renderSpectrogram();
    });

    document.getElementById('select-colormap').addEventListener('change', (e) => {
      this.spectrogram.colormap = e.target.value;
      this._renderSpectrogram();
    });

    document.getElementById('select-channel').addEventListener('change', (e) => {
      const val = e.target.value;
      this.spectrogram.channel = val;
      this._renderSpectrogram();
    });

    document.getElementById('input-freq-min').addEventListener('change', (e) => {
      this.spectrogram.freqMin = parseFloat(e.target.value);
      this._renderSpectrogram();
    });

    document.getElementById('input-freq-max').addEventListener('change', (e) => {
      this.spectrogram.freqMax = parseFloat(e.target.value);
      this._renderSpectrogram();
    });

    document.getElementById('select-freq-preset').addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'full') {
        document.getElementById('input-freq-min').value = 0;
        document.getElementById('input-freq-max').value = this.spectrogram.freqMax;
        this.spectrogram.freqMin = 0;
      } else if (val === 'bat') {
        document.getElementById('input-freq-min').value = 15000;
        document.getElementById('input-freq-max').value = 150000;
        this.spectrogram.freqMin = 15000;
        this.spectrogram.freqMax = Math.min(150000, this.wavInfos[0]?.sampleRate / 2 || 150000);
        document.getElementById('input-freq-max').value = this.spectrogram.freqMax;
      } else if (val === 'bird') {
        document.getElementById('input-freq-min').value = 1000;
        document.getElementById('input-freq-max').value = 12000;
        this.spectrogram.freqMin = 1000;
        this.spectrogram.freqMax = 12000;
      } else if (val === 'audible') {
        document.getElementById('input-freq-min').value = 20;
        document.getElementById('input-freq-max').value = 20000;
        this.spectrogram.freqMin = 20;
        this.spectrogram.freqMax = 20000;
      }
      this._renderSpectrogram();
    });

    document.getElementById('check-log').addEventListener('change', (e) => {
      this.spectrogram.logScale = e.target.checked;
      if (this.spectrogram.logScale && this.spectrogram.freqMin === 0) {
        this.spectrogram.freqMin = 10;
        document.getElementById('input-freq-min').value = 10;
      }
      this._renderSpectrogram();
    });

    // Spectrogram callbacks
    this.spectrogram.onSeek = (timeSec) => {
      this.audio.seek(timeSec);
      this.spectrogram.updatePlaybackCursor(timeSec);
      this._updateInfoStrip();
    };

    this.spectrogram.onSelectionChange = (startSample, endSample) => {
      this._updateSelectionUI(startSample, endSample);
    };

    this.spectrogram.onCursorMove = (sample, freq) => {
      const timeSec = sample / (this.wavInfos[0]?.sampleRate || 1);
      document.getElementById('info-cursor').textContent =
        `${this._formatFreq(freq)} @ ${this._formatTime(timeSec)}`;
    };

    // Annotations panel
    document.getElementById('btn-close-annotations').addEventListener('click', () => {
      this._toggleAnnotationsPanel(false);
    });
    document.getElementById('btn-add-annotation').addEventListener('click', () => this._addAnnotation());
    document.getElementById('btn-export-annotations').addEventListener('click', () => this._exportAnnotations());
    document.getElementById('btn-import-annotations').addEventListener('click', () => {
      document.getElementById('annotations-import-input').click();
    });
    document.getElementById('annotations-import-input').addEventListener('change', (e) => {
      this._importAnnotations(e.target.files[0]);
    });
  }

  _initDragDrop() {
    const dropZone = document.getElementById('drop-zone');
    const body = document.body;

    body.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('active');
    });

    body.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null || !body.contains(e.relatedTarget)) {
        dropZone.classList.remove('active');
      }
    });

    body.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('active');
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.wav'));
      if (files.length > 0) this._loadFiles(files);
    });
  }

  _initKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Don't capture when typing in inputs
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }

      switch (e.key) {
        case ' ':
          e.preventDefault();
          this._togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.audio.seekRelative(e.shiftKey ? -10 : -1);
          this.spectrogram.updatePlaybackCursor(this.audio.getCurrentTime());
          this._updateInfoStrip();
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.audio.seekRelative(e.shiftKey ? 10 : 1);
          this.spectrogram.updatePlaybackCursor(this.audio.getCurrentTime());
          this._updateInfoStrip();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this._adjustSpecGain(5);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._adjustSpecGain(-5);
          break;
        case '+': case '=':
          this.spectrogram.zoomIn();
          break;
        case '-':
          this.spectrogram.zoomOut();
          break;
        case 'f': case 'F':
          this.spectrogram.fitAll();
          break;
        case 'g': case 'G':
          e.preventDefault();
          document.getElementById('input-goto').focus();
          break;
        case 'Home':
          e.preventDefault();
          this.audio.seek(0);
          this.spectrogram.updatePlaybackCursor(0);
          this._updateInfoStrip();
          break;
        case 'End':
          e.preventDefault();
          const dur = this.audio.getDuration();
          this.audio.seek(dur);
          this.spectrogram.updatePlaybackCursor(dur);
          this._updateInfoStrip();
          break;
        case 'Escape':
          this.spectrogram.clearSelection();
          this._updateSelectionUI(null, null);
          break;
      }
    });
  }

  _initAudioCallbacks() {
    this.audio.onTimeUpdate = (time) => {
      // Only CSS transform on cursor — no DOM text updates here
      this.spectrogram.updatePlaybackCursor(time);
    };

    this.audio.onEnded = () => {
      document.getElementById('btn-play').textContent = '\u25B6 Play';
    };
  }

  // --- File loading ---

  async _loadFiles(files) {
    this._setStatus('Loading files...');
    try {
      const wavInfos = [];
      for (const file of files) {
        const info = await WavParser.parse(file);
        wavInfos.push(info);
      }

      this.wavInfos = wavInfos;

      // Hide drop zone, show main UI early so canvas gets dimensions
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';

      // Force canvas size update now that main UI is visible
      this.spectrogram._updateCanvasSize();
      // Pre-initialize cursor element so Safari sets up compositing layers before playback
      this.spectrogram._ensureCursorEl();

      // Wait for spectrogram to fully render before allowing playback
      this._showComputing(true);
      await this.spectrogram.setFiles(wavInfos);
      this._showComputing(false);

      // Load first file for audio
      this._setStatus('Preparing audio...');
      await this.audio.loadFile(wavInfos[0]);

      // Update UI
      this._populateSpeedSelector();
      this._populateChannelSelector();
      this._updateFileInfo();
      this._updateFreqInputs();

      this._setStatus(`Loaded ${files.length} file(s)`);
    } catch (err) {
      this._setStatus(`Error: ${err.message}`);
      console.error(err);
    }
  }

  _populateSpeedSelector() {
    const sel = document.getElementById('select-speed');
    sel.innerHTML = '';
    const options = this.audio.getSpeedOptions();
    for (const opt of options) {
      const el = document.createElement('option');
      el.value = opt.rate;
      el.textContent = opt.label;
      if (opt.rate === 1) el.selected = true;
      sel.appendChild(el);
    }
  }

  _populateChannelSelector() {
    const sel = document.getElementById('select-channel');
    const info = this.wavInfos[0];
    sel.innerHTML = '';

    if (info.channels === 1) {
      sel.style.display = 'none';
      return;
    }

    sel.style.display = '';
    const mix = document.createElement('option');
    mix.value = 'mix';
    mix.textContent = 'Mix';
    sel.appendChild(mix);

    const labels = ['L', 'R', 'C', 'LFE', 'LS', 'RS'];
    for (let i = 0; i < info.channels; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i + 1} (${labels[i] || 'Ch' + (i + 1)})`;
      sel.appendChild(opt);
    }

    if (info.channels === 2) {
      const split = document.createElement('option');
      split.value = '0|1';
      split.textContent = 'L | R';
      sel.appendChild(split);
    }
  }

  _updateFileInfo() {
    const info = this.wavInfos[0];
    const sr = info.sampleRate >= 1000 ? `${(info.sampleRate / 1000).toFixed(info.sampleRate % 1000 === 0 ? 0 : 1)}kHz` : `${info.sampleRate}Hz`;
    const bits = info.format === 'pcm_float' ? '32f' : `${info.bitsPerSample}`;
    const ch = info.channels === 1 ? 'mono' : info.channels === 2 ? 'stereo' : `${info.channels}ch`;

    document.getElementById('info-file').textContent =
      `${info.fileName} | ${sr} ${bits}bit ${ch}`;

    document.getElementById('info-duration').textContent =
      `DUR ${this._formatTime(this.spectrogram.totalDuration)}`;
  }

  _updateFreqInputs() {
    document.getElementById('input-freq-min').value = this.spectrogram.freqMin;
    document.getElementById('input-freq-max').value = Math.round(this.spectrogram.freqMax);
  }

  // --- Playback ---

  async _togglePlay() {
    await this.audio.togglePlay();
    document.getElementById('btn-play').textContent =
      this.audio.isPlaying ? '\u23F8 Pause' : '\u25B6 Play';

    if (this.audio.isPlaying) {
      this._startVUMeter();
      this._startInfoStripTimer();
    } else {
      this._stopVUMeter();
      this._stopInfoStripTimer();
      this._updateInfoStrip();
    }
  }

  _stop() {
    this.audio.stop();
    document.getElementById('btn-play').textContent = '\u25B6 Play';
    this.spectrogram.updatePlaybackCursor(0);
    this._updateInfoStrip();
    this._stopVUMeter();
    this._stopInfoStripTimer();
  }

  // --- Info strip ---

  // Cache DOM refs to avoid getElementById on every frame
  _infoPositionEl = null;
  _infoWallclockEl = null;
  _lastInfoText = '';
  _lastWallText = '';

  _updateInfoStrip() {
    if (!this._infoPositionEl) {
      this._infoPositionEl = document.getElementById('info-position');
      this._infoWallclockEl = document.getElementById('info-wallclock');
    }

    const time = this.audio.getCurrentTime();
    const posText = `POS ${this._formatTime(time)}`;
    // Only touch DOM if text actually changed (avoids triggering Safari layout)
    if (posText !== this._lastInfoText) {
      this._infoPositionEl.textContent = posText;
      this._lastInfoText = posText;
    }

    // Wall clock from BWF
    const info = this.wavInfos[0];
    if (info?.bext) {
      const wallText = `WALL ${this._getWallClock(time)}`;
      if (wallText !== this._lastWallText) {
        this._infoWallclockEl.textContent = wallText;
        this._lastWallText = wallText;
      }
    }
  }

  _getWallClock(positionSec) {
    const info = this.wavInfos[0];
    if (!info?.bext) return '';

    const startSamples = info.bext.timeReference;
    const startSec = startSamples / info.sampleRate;
    const totalSec = startSec + positionSec;

    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const cs = Math.round(s * 100);
    const sWhole = Math.floor(cs / 100);
    const sFrac = cs % 100;

    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sWhole).padStart(2, '0')}.${String(sFrac).padStart(2, '0')}`;
  }

  // --- Selection ---

  _updateSelectionUI(startSample, endSample) {
    const selControls = document.getElementById('selection-controls');
    if (startSample === null) {
      selControls.style.display = 'none';
      this.audio.clearLoop();
      return;
    }

    selControls.style.display = 'flex';
    const sr = this.wavInfos[0].sampleRate;
    const fromSec = startSample / sr;
    const toSec = endSample / sr;

    document.getElementById('input-sel-from').value = this._formatTime(fromSec);
    document.getElementById('input-sel-to').value = this._formatTime(toSec);
    document.getElementById('label-sel-duration').textContent =
      `(${this._formatTime(toSec - fromSec)})`;
  }

  _onSelectionInput() {
    const fromStr = document.getElementById('input-sel-from').value;
    const toStr = document.getElementById('input-sel-to').value;
    const from = this._parseTime(fromStr);
    const to = this._parseTime(toStr);

    if (from !== null && to !== null) {
      const sr = this.wavInfos[0].sampleRate;
      this.spectrogram.selectionStart = Math.floor(from * sr);
      this.spectrogram.selectionEnd = Math.floor(to * sr);
      this.spectrogram.render();
      document.getElementById('label-sel-duration').textContent =
        `(${this._formatTime(to - from)})`;
    }
  }

  _onDurationPreset(val) {
    if (!val || this.spectrogram.selectionStart === null) return;
    const seconds = parseFloat(val);
    const sr = this.wavInfos[0].sampleRate;
    const fromSample = this.spectrogram.selectionStart;
    const toSample = Math.min(fromSample + Math.floor(seconds * sr), this.spectrogram.totalSamples);
    this.spectrogram.selectionEnd = toSample;

    const fromSec = fromSample / sr;
    const toSec = toSample / sr;
    document.getElementById('input-sel-to').value = this._formatTime(toSec);
    document.getElementById('label-sel-duration').textContent =
      `(${this._formatTime(toSec - fromSec)})`;
    this.spectrogram.render();
  }

  _toggleLoop() {
    const btn = document.getElementById('btn-loop');
    if (this.audio.loopStart !== null) {
      this.audio.clearLoop();
      btn.classList.remove('active');
    } else if (this.spectrogram.selectionStart !== null) {
      const sr = this.wavInfos[0].sampleRate;
      this.audio.setLoop(
        this.spectrogram.selectionStart / sr,
        this.spectrogram.selectionEnd / sr
      );
      btn.classList.add('active');
    }
  }

  // --- Export ---

  _getExportRange() {
    const start = this.spectrogram.selectionStart !== null ? this.spectrogram.selectionStart : 0;
    const end = this.spectrogram.selectionEnd !== null ? this.spectrogram.selectionEnd : this.spectrogram.totalSamples;
    return { startSample: start, endSample: end, numSamples: end - start };
  }

  _buildBextInfo(info, startSample, outputSampleRate) {
    if (!info.bext) return null;
    const startTotalSec = (info.bext.timeReference + startSample) / info.sampleRate;
    return {
      description: info.bext.description,
      originator: info.bext.originator,
      originatorReference: info.bext.originatorReference,
      originationDate: info.bext.originationDate,
      originationTime: this._formatHMS(startTotalSec),
      timeReference: Math.round(startTotalSec * outputSampleRate),
    };
  }

  _formatHMS(totalSec) {
    const h = Math.floor(totalSec / 3600) % 24;
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _buildExportFilename(info, startSample, endSample, suffix = '') {
    if (info.bext) {
      const startSec = (info.bext.timeReference + startSample) / info.sampleRate;
      const endSec = (info.bext.timeReference + endSample) / info.sampleRate;
      const startStr = this._formatWallClockISO(info.bext.originationDate, startSec);
      const endStr = this._formatWallClockISO(info.bext.originationDate, endSec);
      return `${startStr}--${endStr}${suffix}.wav`;
    }
    return `export_${this._formatTime(startSample / info.sampleRate).replace(/:/g, '-')}${suffix}.wav`;
  }

  _triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async _exportWav() {
    this._setStatus('Exporting WAV...');
    const info = this.wavInfos[0];
    const { startSample, endSample, numSamples } = this._getExportRange();
    const bextInfo = this._buildBextInfo(info, startSample, info.sampleRate);
    const blob = await WavParser.buildWavBlob(info, startSample, numSamples, bextInfo);
    const filename = this._buildExportFilename(info, startSample, endSample);
    this._triggerDownload(blob, filename);
    this._setStatus(`Exported: ${filename}`);
  }

  _updateExportSpeedButton(rate) {
    const btn = document.getElementById('btn-export-speed');
    if (rate === 1) {
      btn.style.display = 'none';
    } else {
      btn.style.display = '';
      btn.textContent = `Export ${rate}x`;
    }
  }

  async _exportWavAtSpeed() {
    const rate = this.audio.playbackRate;
    if (rate === 1) return;
    const info = this.wavInfos[0];
    const targetSR = Math.round(info.sampleRate * rate);
    this._setStatus(`Exporting WAV at ${targetSR}Hz (${rate}x)...`);
    const { startSample, endSample, numSamples } = this._getExportRange();
    const bextInfo = this._buildBextInfo(info, startSample, targetSR);
    const blob = await WavParser.buildWavBlob(info, startSample, numSamples, bextInfo, targetSR);
    const filename = this._buildExportFilename(info, startSample, endSample, `_${rate}x`);
    this._triggerDownload(blob, filename);
    this._setStatus(`Exported: ${filename}`);
  }

  _formatWallClockISO(date, totalSec) {
    return `${date}T${this._formatHMS(totalSec)}`;
  }

  // --- Go To ---

  _toggleGoToMode() {
    const btn = document.getElementById('btn-goto-mode');
    if (this._goToMode === 'position') {
      this._goToMode = 'wallclock';
      btn.textContent = 'WALL';
    } else {
      this._goToMode = 'position';
      btn.textContent = 'POS';
    }
  }

  _goTo() {
    const input = document.getElementById('input-goto').value.trim();
    if (!input) return;

    let timeSec = this._parseTime(input);
    if (timeSec === null) return;

    if (this._goToMode === 'wallclock' && this.wavInfos[0]?.bext) {
      // Convert wall clock to position
      const startSec = this.wavInfos[0].bext.timeReference / this.wavInfos[0].sampleRate;
      timeSec = timeSec - startSec;
    }

    this.audio.seek(timeSec);
    this.spectrogram.scrollToTime(timeSec);
    this.spectrogram.updatePlaybackCursor(timeSec);
    this._updateInfoStrip();
  }

  // --- Annotations ---

  _toggleAnnotationsPanel(forceShow) {
    const panel = document.getElementById('annotations-panel');
    const btn = document.getElementById('btn-annotations');
    const show = forceShow !== undefined ? forceShow : panel.style.display === 'none';
    panel.style.display = show ? 'flex' : 'none';
    btn.classList.toggle('active', show);
    if (show) this._renderAnnotationsList();
    // Canvas resized — trigger spectrogram redraw
    setTimeout(() => {
      this.spectrogram._updateCanvasSize();
      this.spectrogram._tileCache.clear();
      this.spectrogram.render();
    }, 50);
  }

  _addAnnotation() {
    if (this.spectrogram.selectionStart === null) {
      this._setStatus('Select a region first');
      return;
    }

    const note = document.getElementById('input-annotation-note').value.trim();
    if (!note) return;

    const sr = this.wavInfos[0].sampleRate;
    const info = this.wavInfos[0];
    const ann = {
      sessionStart: this.spectrogram.selectionStart,
      sessionEnd: this.spectrogram.selectionEnd,
      note,
    };

    if (info.bext) {
      const startSec = (info.bext.timeReference + ann.sessionStart) / sr;
      const endSec = (info.bext.timeReference + ann.sessionEnd) / sr;
      ann.wallClockStartISO = this._formatWallClockISO(info.bext.originationDate, startSec);
      ann.wallClockEndISO = this._formatWallClockISO(info.bext.originationDate, endSec);
    }

    this.annotations.push(ann);
    this.spectrogram.setAnnotations(this.annotations);
    document.getElementById('input-annotation-note').value = '';
    this._renderAnnotationsList();
  }

  _renderAnnotationsList() {
    const list = document.getElementById('annotations-list');
    list.innerHTML = '';
    const sr = this.wavInfos[0]?.sampleRate || 1;

    for (let i = 0; i < this.annotations.length; i++) {
      const ann = this.annotations[i];
      const div = document.createElement('div');
      div.className = 'annotation-item';
      const fromStr = this._formatTime(ann.sessionStart / sr);
      const toStr = this._formatTime(ann.sessionEnd / sr);
      div.innerHTML = `
        <span class="annotation-time">${fromStr} - ${toStr}</span>
        <span class="annotation-note">${ann.note}</span>
        <button class="btn-small btn-del-annotation" data-idx="${i}">\u00D7</button>
      `;
      list.appendChild(div);
    }

    list.querySelectorAll('.btn-del-annotation').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.idx);
        this.annotations.splice(idx, 1);
        this.spectrogram.setAnnotations(this.annotations);
        this._renderAnnotationsList();
      });
    });
  }

  _exportAnnotations() {
    const json = JSON.stringify(this.annotations, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    this._triggerDownload(blob, 'annotations.json');
  }

  async _importAnnotations(file) {
    if (!file) return;
    const text = await file.text();
    try {
      const imported = JSON.parse(text);
      this.annotations = imported;
      this.spectrogram.setAnnotations(this.annotations);
      this._renderAnnotationsList();
      this._setStatus(`Imported ${imported.length} annotations`);
    } catch (err) {
      this._setStatus('Failed to import annotations');
    }
  }

  // --- VU Meter ---

  _startVUMeter() {
    const peak = document.getElementById('vu-peak');
    const rms = document.getElementById('vu-rms');
    const update = () => {
      if (!this.audio.isPlaying) return;
      const vu = this.audio.getVUMeter();
      const pWidth = Math.max(0, Math.min(100, (vu.peak + 60) / 60 * 100));
      const rWidth = Math.max(0, Math.min(100, (vu.rms + 60) / 60 * 100));
      peak.style.width = pWidth + '%';
      rms.style.width = rWidth + '%';
      this._vuRAF = requestAnimationFrame(update);
    };
    this._vuRAF = requestAnimationFrame(update);
  }

  _stopVUMeter() {
    if (this._vuRAF) cancelAnimationFrame(this._vuRAF);
  }

  // Info strip updates run on a separate setInterval to avoid polluting the RAF loop
  _infoInterval = null;

  _startInfoStripTimer() {
    this._stopInfoStripTimer();
    this._infoInterval = setInterval(() => {
      this._updateInfoStrip();
    }, 100);
  }

  _stopInfoStripTimer() {
    if (this._infoInterval) {
      clearInterval(this._infoInterval);
      this._infoInterval = null;
    }
  }

  // --- Helpers ---

  _showComputing(show) {
    document.getElementById('computing-indicator').style.display = show ? '' : 'none';
  }

  async _renderSpectrogram() {
    this.spectrogram._tileCache.clear();
    this._showComputing(true);
    await this.spectrogram.render();
    this._showComputing(false);
  }

  _debouncedRender() {
    if (this._settingsTimer) clearTimeout(this._settingsTimer);
    this._showComputing(true);
    this._settingsTimer = setTimeout(async () => {
      this.spectrogram._tileCache.clear();
      await this.spectrogram.render();
      this._showComputing(false);
    }, 200);
  }

  _adjustSpecGain(delta) {
    const input = document.getElementById('input-spec-gain');
    const newVal = parseFloat(input.value) + delta;
    input.value = newVal;
    this.spectrogram.dbMax = newVal;
    document.getElementById('label-spec-gain').textContent = `${newVal} dB`;
    this._debouncedRender();
  }

  _formatTime(seconds) {
    if (isNaN(seconds) || seconds === null) return '0:00.00';
    const cs = Math.round(Math.abs(seconds) * 100);
    const totalSec = Math.floor(cs / 100);
    const centis = cs % 100;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    const sign = seconds < 0 ? '-' : '';
    if (h > 0) {
      return `${sign}${h}:${String(mm).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
    }
    return `${sign}${mm}:${String(s).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

  _parseTime(str) {
    str = str.trim();
    // Try H:MM:SS.cc, M:SS.cc, M:SS, or plain seconds
    const parts = str.split(':');
    let seconds = 0;
    if (parts.length === 3) {
      seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    } else {
      seconds = parseFloat(str);
    }
    return isNaN(seconds) ? null : seconds;
  }

  _formatFreq(freq) {
    if (freq >= 1000) {
      return `${(freq / 1000).toFixed(1)}kHz`;
    }
    return `${Math.round(freq)}Hz`;
  }

  _setStatus(msg) {
    document.getElementById('status-bar').textContent = msg;
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
