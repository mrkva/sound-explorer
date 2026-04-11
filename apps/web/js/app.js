/**
 * Main application controller — wires together WAV parser, spectrogram, audio engine, and UI.
 */

import { VERSION } from './version.js';
import { WavParser } from './wav-parser.js?v=0.2.3';
import { SpectrogramRenderer } from './spectrogram.js?v=0.2.3';
import { AudioEngine } from './audio-engine.js?v=0.2.3';
import { parseIXML, buildIXML, formDataToIXML, ixmlToFormData } from './ixml.js';
import { parseFRM, serializeFRM } from './frm.js';
import { LiveCapture } from './live-capture.js';

class App {
  constructor() {
    this.spectrogram = null;
    this.audio = new AudioEngine();
    this.wavInfos = [];
    this.annotations = [];
    this._vuRAF = null;
    this._settingsTimer = null;
    this._spectGain = 0;
    this._spectRange = 90;
    this._liveCapture = null;
    this._livePeakDb = -100;
    this._liveRmsDb = -100;

    this._initUI();
    this._initDragDrop();
    this._initKeyboard();
    this._initAudioCallbacks();
    this._applyVersion();
    this._initFullscreen();
  }

  _applyVersion() {
    const v = `v${VERSION}`;
    document.querySelectorAll('.drop-version, .toolbar-version').forEach(el => {
      el.textContent = v;
    });
    document.title = `Sound Explorer ${v}`;
    console.log(`Sound Explorer ${v}`);
  }

  _updateUI() {
    const hasFile = this.wavInfos && this.wavInfos.length > 0;
    const isLive = !!(this._liveCapture && this._liveCapture.isCapturing);
    const isFrozen = !hasFile && !isLive && !!this.spectrogram?._lastBitmap;
    const hasRecording = !!this._liveRecordingBlob;
    const isMobile = window.innerWidth <= 768;

    const vis = {
      // Always visible
      'btn-open-file': true,
      'btn-live': true,
      'btn-vu': true,
      'btn-theme': !isMobile || !isLive,
      'btn-shortcuts': !isMobile,

      // File playback
      'btn-play': hasFile,
      'btn-stop': hasFile,
      'select-speed': hasFile,
      'btn-export': hasFile,
      'btn-export-speed': false, // managed by speed selector logic

      // Navigation (file or frozen)
      'btn-zoom-in': hasFile || isFrozen,
      'btn-zoom-out': hasFile || isFrozen,
      'btn-fit': hasFile || isFrozen,
      'btn-sel': hasFile,
      'btn-trim': hasFile,
      'btn-untrim': false, // managed by trim logic
      'btn-goto-mode': hasFile && !isMobile,
      'input-goto': hasFile && !isMobile,
      'btn-goto': hasFile && !isMobile,

      // Sidebar
      'btn-annotations': hasFile,
      'btn-metadata': hasFile,

      // Live controls (inside #live-controls container)
      'btn-live-record': isLive,
      'btn-live-stop': false, // stop handled by btn-live toggle
      'btn-live-save': hasRecording && !isLive,
      'live-status': isLive && !isMobile,
    };

    for (const [id, show] of Object.entries(vis)) {
      const el = document.getElementById(id);
      if (el) el.style.display = show ? '' : 'none';
    }

    // Live controls container — device selector, window, rec, stop
    const liveCtrl = document.getElementById('live-controls');
    if (liveCtrl) liveCtrl.classList.toggle('active', isLive);

    // Volume group (file mode only)
    const volGroup = document.getElementById('input-volume')?.closest('.control-group');
    if (volGroup) volGroup.style.display = hasFile ? '' : 'none';

    // Info strip: hide on mobile during active live
    const infoStrip = document.getElementById('info-strip');
    if (infoStrip) infoStrip.style.display = (isMobile && isLive) ? 'none' : '';

    // Toolbar separators and labels: show when file or frozen content present
    const showSeps = hasFile || isFrozen;
    document.querySelectorAll('#toolbar .toolbar-sep').forEach(el => {
      el.style.display = showSeps ? '' : 'none';
    });
    document.querySelectorAll('#toolbar .toolbar-label').forEach(el => {
      el.style.display = (showSeps && !isMobile) ? '' : 'none';
    });

    // Live button: toggle between Live / Stop (icon + label span)
    const btnLive = document.getElementById('btn-live');
    if (btnLive) {
      btnLive.firstChild.textContent = isLive ? '\u25A0' : '\u25C9';
      const lbl = btnLive.querySelector('.btn-label');
      if (lbl) lbl.textContent = isLive ? ' Stop' : ' Live';
      btnLive.classList.toggle('btn-live-active', isLive);
    }
  }

  _initFullscreen() {
    // Skip if already running as installed PWA or if Fullscreen API unavailable
    if (window.matchMedia('(display-mode: standalone)').matches) return;
    if (window.matchMedia('(display-mode: fullscreen)').matches) return;
    if (!document.documentElement.requestFullscreen) return;

    // Only auto-fullscreen on mobile (touch devices with small screens)
    const isMobile = 'ontouchstart' in window && window.innerWidth <= 768;
    if (!isMobile) return;

    // On first user interaction in landscape, request fullscreen to hide browser toolbar
    const tryFullscreen = () => {
      const isLandscape = window.innerWidth > window.innerHeight;
      if (isLandscape && !document.fullscreenElement) {
        document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
      }
      document.removeEventListener('click', tryFullscreen);
      document.removeEventListener('touchend', tryFullscreen);
    };
    document.addEventListener('click', tryFullscreen, { once: true });
    document.addEventListener('touchend', tryFullscreen, { once: true });
  }

  // --- UI References ---

  _initUI() {
    // Canvas
    const canvas = document.getElementById('spectrogram-canvas');
    this.spectrogram = new SpectrogramRenderer(canvas);

    // Waveform overview / minimap
    const overviewEl = document.getElementById('overview-canvas');
    if (overviewEl) this.spectrogram.setOverviewCanvas(overviewEl);

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
    document.getElementById('btn-sel').addEventListener('click', () => this._zoomToSelection());
    document.getElementById('btn-trim').addEventListener('click', () => this._trimSelection());
    document.getElementById('btn-untrim').addEventListener('click', () => this._untrimSession());

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

    // Sidebar (annotations + metadata tabs)
    document.getElementById('btn-annotations').addEventListener('click', () => this._toggleSidebar('annotations'));
    document.getElementById('btn-metadata').addEventListener('click', () => this._toggleSidebar('metadata'));
    document.getElementById('btn-close-sidebar').addEventListener('click', () => this._closeSidebar());
    document.getElementById('app-sidebar').querySelectorAll('.sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => { if (tab.dataset.tab) this._switchSidebarTab(tab.dataset.tab); });
    });
    document.getElementById('btn-vu').addEventListener('click', () => this._toggleBigVU());

    // Metadata form
    this._setupMetadataForm();

    // Dark mode toggle
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') document.body.classList.add('dark');
    const toggleTheme = () => {
      document.body.classList.toggle('dark');
      const isDark = document.body.classList.contains('dark');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      const icon = isDark ? '&#x2600;' : '&#x263E;';
      document.getElementById('btn-theme').innerHTML = icon;
      document.getElementById('btn-theme-bottom').innerHTML = icon;
    };
    document.getElementById('btn-theme').addEventListener('click', toggleTheme);
    document.getElementById('btn-theme-bottom').addEventListener('click', toggleTheme);
    if (savedTheme === 'dark') {
      document.getElementById('btn-theme').innerHTML = '&#x2600;';
      document.getElementById('btn-theme-bottom').innerHTML = '&#x2600;';
    }

    // Shortcuts dialog
    document.getElementById('btn-shortcuts').addEventListener('click', () => {
      document.getElementById('shortcuts-dialog').showModal();
    });
    document.getElementById('btn-close-shortcuts').addEventListener('click', () => {
      document.getElementById('shortcuts-dialog').close();
    });

    // Collapsible bottom bar (mobile)
    const bottomBar = document.getElementById('bottom-bar');
    const bottomToggle = document.getElementById('btn-toggle-bottom');
    if (bottomToggle) {
      const savedCollapsed = localStorage.getItem('bottomBarCollapsed');
      if (savedCollapsed === 'true' || (savedCollapsed === null && window.innerWidth <= 768)) {
        bottomBar.classList.add('collapsed');
        bottomToggle.innerHTML = '&#9650; Settings';
      }
      bottomToggle.addEventListener('click', () => {
        bottomBar.classList.toggle('collapsed');
        const collapsed = bottomBar.classList.contains('collapsed');
        bottomToggle.innerHTML = collapsed ? '&#9650; Settings' : '&#9660; Settings';
        localStorage.setItem('bottomBarCollapsed', collapsed);
      });
    }

    // Bottom bar controls
    document.getElementById('input-gain').addEventListener('input', (e) => {
      const db = parseFloat(e.target.value);
      this.audio.setGain(db);
      this.spectrogram.gainDB = db;
      document.getElementById('label-gain').textContent = `${db} dB`;
    });

    document.getElementById('input-volume').addEventListener('input', (e) => {
      this.audio.setVolume(parseFloat(e.target.value));
    });

    document.getElementById('input-spec-gain').addEventListener('input', (e) => {
      this._spectGain = parseFloat(e.target.value);
      this.spectrogram.dbMax = this._spectGain;
      this.spectrogram.dbMin = this._spectGain - this._spectRange;
      document.getElementById('label-spec-gain').textContent = `${this._spectGain} dB`;
      this._debouncedRender();
    });

    document.getElementById('input-spec-range').addEventListener('input', (e) => {
      this._spectRange = parseFloat(e.target.value);
      this.spectrogram.dbMin = this._spectGain - this._spectRange;
      document.getElementById('label-spec-range').textContent = `${this._spectRange} dB`;
      this._debouncedRender();
    });

    document.getElementById('select-fft').addEventListener('change', (e) => {
      this.spectrogram.fftSize = parseInt(e.target.value);
      this._renderSpectrogram();
    });

    document.getElementById('select-fft-window').addEventListener('change', (e) => {
      this.spectrogram.windowType = e.target.value;
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
      const nyquist = this.wavInfos[0]?.sampleRate / 2 || 96000;
      const presets = {
        full:  [0, nyquist],
        bird:  [100, 10000],
        voice: [80, 4000],
        low:   [20, 500],
        mid:   [200, 8000],
      };
      const p = presets[val];
      if (p) {
        this.spectrogram.freqMin = p[0];
        this.spectrogram.freqMax = Math.min(p[1], nyquist);
        document.getElementById('input-freq-min').value = this.spectrogram.freqMin;
        document.getElementById('input-freq-max').value = this.spectrogram.freqMax;
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

    // Live input — toolbar toggle and drop zone button
    document.getElementById('btn-live').addEventListener('click', () => {
      if (this._liveCapture && this._liveCapture.isCapturing) {
        this._stopLive();
      } else {
        this._startLive();
      }
    });
    document.getElementById('btn-live-start').addEventListener('click', () => this._startLive());
    document.getElementById('btn-live-stop').addEventListener('click', () => this._stopLive());
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

    // Annotations controls
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
        case 's': case 'S':
          this._zoomToSelection();
          break;
        case 't': case 'T':
          this._trimSelection();
          break;
        case 'u': case 'U':
          this._untrimSession();
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
      document.getElementById('btn-play').querySelector('.btn-label').textContent = ' Play';
    };
  }

  // --- File loading ---

  async _loadFiles(files) {
    this._setStatus('Loading files...');
    try {
      // Stop live capture if active
      if (this._liveCapture) {
        this.spectrogram.stopLive();
        try { await this._liveCapture.stop(); } catch (_) {}
        this._liveCapture = null;
        this._stopVUMeter();
      }

      const wavInfos = [];
      for (const file of files) {
        const info = await WavParser.parse(file);
        wavInfos.push(info);
      }

      this.wavInfos = wavInfos;

      // Hide drop zone, show main UI early so canvas gets dimensions
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';

      // Wait for browser to complete layout before measuring canvas
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Force canvas size update now that main UI is visible
      this.spectrogram._updateCanvasSize();
      // Pre-initialize cursor element so Safari sets up compositing layers before playback
      this.spectrogram._ensureCursorEl();

      // Auto-switch to Hann for file analysis (best frequency resolution)
      this.spectrogram.windowType = 'hann';
      document.getElementById('select-fft-window').value = 'hann';

      // Wait for spectrogram to fully render before allowing playback
      this._showComputing(true);
      await this.spectrogram.setFiles(wavInfos);
      this._showComputing(false);

      // Compute waveform overview in background
      this.spectrogram.computeOverview();

      // Load first file for audio
      this._setStatus('Preparing audio...');
      await this.audio.loadFile(wavInfos[0]);

      // Update UI
      this._populateSpeedSelector();
      this._populateChannelSelector();
      this._buildBigVUMeter(wavInfos[0].channels);
      this._updateFileInfo();
      this._updateFreqInputs();
      this._updateUI();

      this._setStatus(`Loaded ${files.length} file(s)`);
      this._showCanvasHint();
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
    const group = document.getElementById('channel-group');
    const info = this.wavInfos[0];
    sel.innerHTML = '';

    if (info.channels === 1) {
      group.style.display = 'none';
      return;
    }

    group.style.display = '';
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
    const playBtn = document.getElementById('btn-play');
    playBtn.firstChild.textContent = this.audio.isPlaying ? '\u23F8' : '\u25B6';
    playBtn.querySelector('.btn-label').textContent = this.audio.isPlaying ? ' Pause' : ' Play';

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
    const playBtn = document.getElementById('btn-play');
    playBtn.firstChild.textContent = '\u25B6';
    playBtn.querySelector('.btn-label').textContent = ' Play';
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

  // --- Zoom to Selection / Trim ---

  _zoomToSelection() {
    if (!this.spectrogram || this.spectrogram.selectionStart === null) return;
    const start = this.spectrogram.selectionStart;
    const end = this.spectrogram.selectionEnd;
    if (end - start < 1) return;
    const pad = (end - start) * 0.05;
    this.spectrogram.setView(start - pad, end + pad);
  }

  _trimSelection() {
    if (!this.spectrogram || this.spectrogram.selectionStart === null) return;
    const start = this.spectrogram.selectionStart;
    const end = this.spectrogram.selectionEnd;
    if (end - start < 1) return;

    this.spectrogram.trimStart = start;
    this.spectrogram.trimEnd = end;

    // Clear selection and zoom to trim
    this.spectrogram.clearSelection();
    this._updateSelectionUI(null, null);
    this.spectrogram.setView(start, end);
    this._updateTrimUI();

    const sr = this.wavInfos[0].sampleRate;
    const dur = (end - start) / sr;
    this._setStatus(`Trimmed to ${this._formatTime(dur)} — press U or click Untrim to restore`);
  }

  _untrimSession() {
    if (!this.spectrogram || this.spectrogram.trimStart === null) return;
    this.spectrogram.trimStart = null;
    this.spectrogram.trimEnd = null;
    this.spectrogram.fitAll();
    this._updateTrimUI();
    this._setStatus('Trim removed — full file restored');
  }

  _updateTrimUI() {
    const trimmed = this.spectrogram && this.spectrogram.trimStart !== null;
    document.getElementById('btn-untrim').style.display = trimmed ? '' : 'none';
  }

  // --- Export ---

  _getExportRange() {
    const sp = this.spectrogram;
    let start, end;
    if (sp.selectionStart !== null) {
      start = sp.selectionStart;
      end = sp.selectionEnd;
    } else if (sp.trimStart !== null) {
      start = sp.trimStart;
      end = sp.trimEnd;
    } else {
      start = 0;
      end = sp.totalSamples;
    }
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
      const label = btn.querySelector('.btn-label-speed');
      if (label) label.textContent = ` ${rate}x`;
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
      btn.textContent = 'Wall Clock';
    } else {
      this._goToMode = 'position';
      btn.textContent = 'Position';
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

  // --- Sidebar (Annotations + Metadata) ---

  _toggleSidebar(tab) {
    const sidebar = document.getElementById('app-sidebar');
    const isOpen = sidebar.classList.contains('open');
    const currentTab = sidebar.querySelector('.sidebar-tab.active')?.dataset.tab;

    if (isOpen && currentTab === tab) {
      this._closeSidebar();
    } else {
      sidebar.classList.add('open');
      this._switchSidebarTab(tab);
      if (tab === 'annotations') this._renderAnnotationsList();
      if (tab === 'metadata') this._populateMetadataForm();
    }
    this._resizeSidebar();
  }

  _closeSidebar() {
    document.getElementById('app-sidebar').classList.remove('open');
    this._resizeSidebar();
  }

  _switchSidebarTab(tab) {
    const sidebar = document.getElementById('app-sidebar');
    sidebar.querySelectorAll('.sidebar-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
    sidebar.querySelectorAll('.sidebar-pane').forEach(p => {
      p.classList.toggle('active', p.dataset.tab === tab);
    });
    if (tab === 'metadata') this._populateMetadataForm();
  }

  _resizeSidebar() {
    setTimeout(() => {
      this.spectrogram._updateCanvasSize();
      this.spectrogram._tileCache.clear();
      this.spectrogram.render();
    }, 50);
    setTimeout(() => {
      this.spectrogram._updateCanvasSize();
      this.spectrogram._tileCache.clear();
      this.spectrogram.render();
    }, 250);
  }

  _toggleAnnotationsPanel(forceShow) {
    // Legacy compat — routes to sidebar
    const sidebar = document.getElementById('app-sidebar');
    if (forceShow === false) {
      this._closeSidebar();
    } else {
      this._toggleSidebar('annotations');
    }
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

  _bigVURows = []; // [{cover, peakBar, track, dbLabel, peakHoldDb, peakHoldTime}]
  _bigVUVisible = true;
  _peakHoldDuration = 2000; // ms to hold peak before decay
  _peakDecayRate = 12;      // dB/s decay speed (IEC 60268-10 Type II: 20 dB / 1.7s ≈ 12 dB/s)

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

      const trackWrap = document.createElement('div');
      trackWrap.className = 'vu-channel-track-wrap';

      const track = document.createElement('div');
      track.className = 'vu-channel-track';
      trackWrap.appendChild(track);

      const peakBar = document.createElement('div');
      peakBar.className = 'vu-channel-peak';
      peakBar.style.left = '0%';
      trackWrap.appendChild(peakBar);

      row.appendChild(trackWrap);

      const dbLabel = document.createElement('span');
      dbLabel.className = 'vu-channel-db';
      dbLabel.innerHTML = '<span class="vu-db-rms">-∞</span> / <span class="vu-db-peak">-∞</span>';
      row.appendChild(dbLabel);

      container.appendChild(row);
      this._bigVURows.push({
        peakBar, track, dbLabel,
        smoothedDb: -100,
        peakHoldDb: -100,
        peakHoldTime: 0,
      });
    }

    // dBFS scale row
    const scaleRow = document.createElement('div');
    scaleRow.className = 'vu-scale';

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

    // Restore visibility from previous state
    const saved = localStorage.getItem('bigVU');
    this._bigVUVisible = saved !== 'hidden';
    container.style.display = this._bigVUVisible ? 'flex' : 'none';
    this._updateVUButton();
  }

  _updateVUButton() {
    const btn = document.getElementById('btn-vu');
    if (this._bigVUVisible) {
      btn.textContent = 'VU Meter';
      btn.classList.add('active');
    } else {
      btn.textContent = 'VU Meter';
      btn.classList.remove('active');
    }
  }

  _toggleBigVU() {
    this._bigVUVisible = !this._bigVUVisible;
    document.getElementById('vu-meter-big').style.display =
      this._bigVUVisible ? 'flex' : 'none';
    this._updateVUButton();
    localStorage.setItem('bigVU', this._bigVUVisible ? 'visible' : 'hidden');
  }

  _startVUMeter(live = false) {
    const bigRows = this._bigVURows;
    let lastTime = performance.now();
    let lastTextUpdate = 0;

    const update = (now) => {
      if (!live && !this.audio.isPlaying) return;
      if (live && (!this._liveCapture || !this._liveCapture.isCapturing)) return;
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      // Big per-channel VU — skip if hidden
      if (bigRows.length > 0 && this._bigVUVisible) {
        const channels = live
          ? [{ peak: this._livePeakDb, rms: this._liveRmsDb }]
          : this.audio.getChannelVUMeters();
        const updateText = (now - lastTextUpdate) > 150;
        if (updateText) lastTextUpdate = now;

        for (let i = 0; i < bigRows.length && i < channels.length; i++) {
          const ch = channels[i];
          const r = bigRows[i];

          // True-peak bar: instant attack, IEC 60268-10 decay (8.7 dB/s)
          const targetDb = Math.max(-100, ch.peak);
          if (targetDb > r.smoothedDb) {
            r.smoothedDb = targetDb;
          } else {
            r.smoothedDb = Math.max(r.smoothedDb - 8.7 * dt, targetDb);
          }
          const barW = Math.max(0, Math.min(100, (r.smoothedDb + 60) / 60 * 100));
          r.track.style.clipPath = `inset(0 ${100 - barW}% 0 0)`;

          // Peak hold: latch at highest value, hold, then decay
          if (ch.peak >= r.peakHoldDb) {
            r.peakHoldDb = ch.peak;
            r.peakHoldTime = now;
          } else if (now - r.peakHoldTime > this._peakHoldDuration) {
            r.peakHoldDb -= this._peakDecayRate * dt;
            if (r.peakHoldDb < -100) r.peakHoldDb = -100;
          }

          const peakW = Math.max(0, Math.min(100, (r.peakHoldDb + 60) / 60 * 100));
          r.peakBar.style.left = peakW + '%';

          // Throttle text updates to ~7 fps for readability
          if (updateText) {
            const peakText = r.peakHoldDb <= -100 ? ' -∞' : `${r.peakHoldDb.toFixed(1)}`;
            const rmsText = ch.rms <= -100 ? ' -∞' : `${ch.rms.toFixed(1)}`;
            r.dbLabel.innerHTML =
              `<span class="vu-db-rms">${rmsText}</span> / <span class="vu-db-peak">${peakText}</span>`;
          }
        }
      }

      this._vuRAF = requestAnimationFrame(update);
    };
    this._vuRAF = requestAnimationFrame(update);
  }

  _stopVUMeter() {
    if (this._vuRAF) cancelAnimationFrame(this._vuRAF);
    // Reset big VU bars
    for (const row of this._bigVURows) {
      row.track.style.clipPath = 'inset(0 100% 0 0)';
      row.peakBar.style.left = '0%';
      row.smoothedDb = -100;
      row.peakHoldDb = -100;
      row.peakHoldTime = 0;
      row.dbLabel.innerHTML = '<span class="vu-db-rms">-∞</span> / <span class="vu-db-peak">-∞</span>';
    }
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

  _showCanvasHint() {
    if (localStorage.getItem('hintShown')) return;
    localStorage.setItem('hintShown', '1');
    const hint = document.createElement('div');
    hint.className = 'canvas-hint';
    hint.innerHTML = 'Scroll to zoom &nbsp;&bull;&nbsp; Right-drag to pan &nbsp;&bull;&nbsp; Left-drag to select';
    document.getElementById('canvas-container').appendChild(hint);
    setTimeout(() => { hint.style.opacity = '0'; }, 5000);
    setTimeout(() => { hint.remove(); }, 5800);
  }

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
    const newVal = Math.max(0, Math.min(80, parseFloat(input.value) + delta));
    input.value = newVal;
    this._spectGain = newVal;
    this.spectrogram.dbMax = this._spectGain;
    this.spectrogram.dbMin = this._spectGain - this._spectRange;
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

  // --- Metadata editor ---

  _setupMetadataForm() {
    document.getElementById('frm-download').addEventListener('click', () => this._downloadFRM());
    document.getElementById('frm-add-mic').addEventListener('click', () => this._addMicRow());

    // Location presets
    document.getElementById('frm-loc-preset').addEventListener('change', (e) => {
      this._applyLocationPreset(e.target.value);
    });
    document.getElementById('frm-loc-save-preset').addEventListener('click', () => this._saveLocationPreset());
    document.getElementById('frm-loc-del-preset').addEventListener('click', () => this._deleteLocationPreset());
  }

  _populateMetadataForm() {
    if (!this.wavInfos.length) return;
    const info = this.wavInfos[0];

    // Auto-fill readonly fields
    document.getElementById('frm-eq-sr').value = info.sampleRate || '';
    document.getElementById('frm-eq-bits').value = info.bitsPerSample || '';

    // Status
    const status = document.getElementById('meta-status');
    if (this._metadataPopulated) {
      return; // already populated, don't overwrite user edits
    }

    // Try to populate from iXML
    if (info.ixml) {
      try {
        const ixmlMeta = parseIXML(info.ixml);
        const formData = ixmlToFormData(ixmlMeta);
        this._applyFormData(formData);
        status.textContent = 'Loaded from iXML chunk';
        this._metadataPopulated = true;
        return;
      } catch (e) {
        console.warn('iXML parse error:', e);
      }
    }

    // Populate from bext if available
    if (info.bext) {
      const b = info.bext;
      if (b.originationDate) {
        const start = `${b.originationDate}T${b.originationTime || '00:00:00'}`;
        document.getElementById('frm-dt-start').value = start;
      }
      status.textContent = 'Auto-populated from BWF';
    } else {
      status.textContent = 'No metadata found in file';
    }

    // Apply sticky defaults from localStorage
    this._applyMetadataDefaults();
    this._populateLocationPresets();
    this._metadataPopulated = true;
  }

  _applyFormData(fd) {
    if (!fd) return;
    const s = (id, val) => { if (val) document.getElementById(id).value = val; };
    const c = (id, val) => { if (val !== undefined) document.getElementById(id).checked = !!val; };

    // Session
    s('frm-title', fd.session?.title);
    s('frm-project', fd.session?.project);
    s('frm-recordist', fd.session?.recordist);
    s('frm-license', fd.session?.license);
    if (fd.session?.tags) {
      s('frm-tags', Array.isArray(fd.session.tags) ? fd.session.tags.join(', ') : fd.session.tags);
    }

    // Time
    s('frm-dt-start', fd.datetime?.start);
    s('frm-dt-end', fd.datetime?.end);
    s('frm-dt-tz', fd.datetime?.timezone);

    // Location
    s('frm-loc-name', fd.location?.name);
    s('frm-loc-region', fd.location?.region);
    if (fd.location?.latitude && fd.location?.longitude) {
      s('frm-loc-gps', `${fd.location.latitude}, ${fd.location.longitude}`);
    }
    s('frm-loc-elev', fd.location?.elevation_m);
    s('frm-loc-env', fd.location?.environment);

    // Conditions
    s('frm-cond-weather', fd.conditions?.weather);
    s('frm-cond-temp', fd.conditions?.temperature_c);
    s('frm-cond-hum', fd.conditions?.humidity_pct);
    s('frm-cond-wind', fd.conditions?.wind);
    s('frm-cond-noise', fd.conditions?.noise_floor);

    // Equipment
    s('frm-eq-model', fd.equipment?.recorder?.model);
    s('frm-eq-gain', fd.equipment?.recorder?.gain_db);
    s('frm-eq-hp', fd.equipment?.recorder?.highpass_hz);
    c('frm-eq-limiter', fd.equipment?.recorder?.limiter);
    c('frm-eq-phantom', fd.equipment?.recorder?.phantom_power);
    c('frm-eq-pip', fd.equipment?.recorder?.plug_in_power);
    s('frm-eq-setup', fd.equipment?.setup);
    if (fd.equipment?.accessories) {
      s('frm-eq-acc', Array.isArray(fd.equipment.accessories) ? fd.equipment.accessories.join(', ') : fd.equipment.accessories);
    }

    // Microphones
    if (fd.equipment?.microphones) {
      const list = document.getElementById('frm-mics-list');
      list.innerHTML = '';
      for (const mic of fd.equipment.microphones) {
        this._addMicRow(mic.id, mic.model, mic.type);
      }
    }

    // Channels
    if (fd.channels) {
      const list = document.getElementById('frm-channels-list');
      list.innerHTML = '';
      for (const [num, ch] of Object.entries(fd.channels)) {
        const row = document.createElement('div');
        row.className = 'frm-channel-row';
        row.innerHTML = `<span>Ch ${num}:</span>
          <input type="text" value="${ch.label || ''}" placeholder="Label" data-ch="${num}" data-field="label">
          <input type="text" value="${ch.source || ''}" placeholder="Source" data-ch="${num}" data-field="source">`;
        list.appendChild(row);
      }
    }

    // Notes
    s('frm-notes', fd.notes);
  }

  _readMetadataForm() {
    const g = (id) => document.getElementById(id)?.value?.trim() || '';
    const ch = (id) => document.getElementById(id)?.checked || false;

    const tagsStr = g('frm-tags');
    const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];

    const gpsStr = g('frm-loc-gps');
    let lat = '', lon = '';
    if (gpsStr) {
      const parts = gpsStr.split(',').map(s => s.trim());
      if (parts.length === 2) { lat = parts[0]; lon = parts[1]; }
    }

    const accStr = g('frm-eq-acc');
    const accessories = accStr ? accStr.split(',').map(a => a.trim()).filter(Boolean) : [];

    // Collect mic rows
    const mics = [];
    document.querySelectorAll('#frm-mics-list .frm-mic-row').forEach(row => {
      const inputs = row.querySelectorAll('input');
      if (inputs.length >= 3) {
        mics.push({ id: inputs[0].value.trim(), model: inputs[1].value.trim(), type: inputs[2].value.trim() });
      }
    });

    // Collect channels
    const channels = {};
    document.querySelectorAll('#frm-channels-list .frm-channel-row input').forEach(inp => {
      const num = inp.dataset.ch;
      if (!channels[num]) channels[num] = {};
      channels[num][inp.dataset.field] = inp.value.trim();
    });

    return {
      session: { title: g('frm-title'), project: g('frm-project'), recordist: g('frm-recordist'), license: g('frm-license'), tags },
      datetime: { start: g('frm-dt-start'), end: g('frm-dt-end'), timezone: g('frm-dt-tz') },
      location: { name: g('frm-loc-name'), region: g('frm-loc-region'), latitude: lat, longitude: lon, elevation_m: g('frm-loc-elev'), environment: g('frm-loc-env') },
      conditions: { weather: g('frm-cond-weather'), temperature_c: g('frm-cond-temp'), humidity_pct: g('frm-cond-hum'), wind: g('frm-cond-wind'), noise_floor: g('frm-cond-noise') },
      equipment: {
        recorder: { model: g('frm-eq-model'), sample_rate: g('frm-eq-sr'), bit_depth: g('frm-eq-bits'), gain_db: g('frm-eq-gain'), highpass_hz: g('frm-eq-hp'), limiter: ch('frm-eq-limiter'), phantom_power: ch('frm-eq-phantom'), plug_in_power: ch('frm-eq-pip') },
        microphones: mics,
        setup: g('frm-eq-setup'),
        accessories
      },
      channels,
      notes: g('frm-notes')
    };
  }

  _downloadFRM() {
    const data = this._readMetadataForm();
    const text = serializeFRM(data);
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'session.frm.txt';
    a.click();
    URL.revokeObjectURL(url);
    this._setStatus('Downloaded session.frm.txt');

    // Save sticky defaults
    const rd = data.session?.recordist;
    if (rd) localStorage.setItem('frm-default-recordist', rd);
    const lic = data.session?.license;
    if (lic) localStorage.setItem('frm-default-license', lic);
    const tz = data.datetime?.timezone;
    if (tz) localStorage.setItem('frm-default-timezone', tz);
    const model = data.equipment?.recorder?.model;
    if (model) localStorage.setItem('frm-default-recorder', model);
  }

  _addMicRow(id, model, type) {
    const list = document.getElementById('frm-mics-list');
    const row = document.createElement('div');
    row.className = 'frm-mic-row';
    row.innerHTML = `
      <input type="text" placeholder="ID" value="${id || ''}">
      <input type="text" placeholder="Model" value="${model || ''}">
      <input type="text" placeholder="Type" value="${type || ''}">
      <button class="btn btn-small" onclick="this.parentElement.remove()">&times;</button>`;
    list.appendChild(row);
  }

  _applyMetadataDefaults() {
    const s = (id, key) => {
      const el = document.getElementById(id);
      if (el && !el.value) {
        const val = localStorage.getItem(key);
        if (val) el.value = val;
      }
    };
    s('frm-recordist', 'frm-default-recordist');
    s('frm-license', 'frm-default-license');
    s('frm-dt-tz', 'frm-default-timezone');
    s('frm-eq-model', 'frm-default-recorder');
  }

  _populateLocationPresets() {
    const presets = JSON.parse(localStorage.getItem('frm-location-presets') || '{}');
    const sel = document.getElementById('frm-loc-preset');
    sel.innerHTML = '<option value="">-- pick --</option>';
    for (const name of Object.keys(presets).sort()) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  }

  _applyLocationPreset(name) {
    if (!name) return;
    const presets = JSON.parse(localStorage.getItem('frm-location-presets') || '{}');
    const p = presets[name];
    if (!p) return;
    document.getElementById('frm-loc-name').value = p.name || '';
    document.getElementById('frm-loc-region').value = p.region || '';
    document.getElementById('frm-loc-gps').value = p.gps || '';
    document.getElementById('frm-loc-elev').value = p.elevation || '';
    document.getElementById('frm-loc-env').value = p.environment || '';
  }

  _saveLocationPreset() {
    const name = document.getElementById('frm-loc-name').value.trim();
    if (!name) { this._setStatus('Enter a location name first'); return; }
    const presets = JSON.parse(localStorage.getItem('frm-location-presets') || '{}');
    presets[name] = {
      name,
      region: document.getElementById('frm-loc-region').value.trim(),
      gps: document.getElementById('frm-loc-gps').value.trim(),
      elevation: document.getElementById('frm-loc-elev').value.trim(),
      environment: document.getElementById('frm-loc-env').value.trim()
    };
    localStorage.setItem('frm-location-presets', JSON.stringify(presets));
    this._populateLocationPresets();
    document.getElementById('frm-loc-preset').value = name;
    this._setStatus(`Saved location preset: ${name}`);
  }

  _deleteLocationPreset() {
    const sel = document.getElementById('frm-loc-preset');
    const name = sel.value;
    if (!name) return;
    const presets = JSON.parse(localStorage.getItem('frm-location-presets') || '{}');
    delete presets[name];
    localStorage.setItem('frm-location-presets', JSON.stringify(presets));
    this._populateLocationPresets();
    this._setStatus(`Deleted location preset: ${name}`);
  }

  /**
   * Get iXML string for embedding in exported WAV, or null if metadata not edited.
   */
  _getExportIXML() {
    if (!document.getElementById('frm-apply-export')?.checked) return null;
    if (!this._metadataPopulated) return null;
    const formData = this._readMetadataForm();
    try {
      const ixmlMeta = formDataToIXML(formData, null, this.annotations);
      return buildIXML(ixmlMeta);
    } catch (e) {
      console.warn('Failed to build iXML for export:', e);
      return null;
    }
  }

  // --- Live Input ---

  async _startLive(deviceId = null) {
    try {
      // Stop any previous live session
      if (this._liveCapture) {
        this.spectrogram.stopLive();
        await this._liveCapture.stop();
      }

      // Stop file playback if active
      if (this.audio.isPlaying) this.audio.stop();

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

      // Start capture
      await this._liveCapture.start(deviceId || sel.value || null);

      // Clear file state — live replaces file mode
      this.wavInfos = [];

      // Show main UI if hidden
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('main-ui').style.display = 'flex';

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      this.spectrogram._updateCanvasSize();

      // Update frequency controls
      const nyquist = this._liveCapture.sampleRate / 2;
      document.getElementById('input-freq-max').value = nyquist;
      this.spectrogram.freqMax = nyquist;
      this.spectrogram.freqMin = 0;
      document.getElementById('input-freq-min').value = 0;

      // Auto-switch to Blackman-Harris for live (best sidelobe suppression)
      this.spectrogram.windowType = 'blackman-harris';
      document.getElementById('select-fft-window').value = 'blackman-harris';

      // Connect spectrogram to live source
      this.spectrogram.setLiveSource(this._liveCapture);

      // Build and start VU meter for live input (mono)
      this._buildBigVUMeter(1);
      this._liveCapture.onLevelUpdate = (peak, rms) => {
        this._livePeakDb = peak > 0 ? 20 * Math.log10(peak) : -100;
        this._liveRmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;
      };
      this._startVUMeter(true);

      this._updateUI();
      this._setStatus(`Live input: ${this._liveCapture.sampleRate} Hz`);
      this._updateLiveStatus();
    } catch (e) {
      console.error('Live input error:', e);
      this._setStatus(`Live input error: ${e.message}`);
    }
  }

  async _stopLive() {
    let recordingBlob = null;
    if (this._liveCapture) {
      // Stop recording if active
      if (this._liveCapture.isRecording) {
        recordingBlob = this._liveCapture.stopRecording();
      }
      // Also grab any previously stopped recording
      if (!recordingBlob) recordingBlob = this._liveRecordingBlob;

      const sr = this._liveCapture.sampleRate;
      const totalSamples = this._liveCapture.totalSamples;

      this.spectrogram.stopLive();
      try {
        await this._liveCapture.stop();
      } catch (e) {
        console.warn('Error stopping live capture (ignored):', e);
      }
      this._liveCapture = null;

      // Stop VU meter
      this._stopVUMeter();
      this._livePeakDb = -100;
      this._liveRmsDb = -100;

      // If we have a recording, load it into file analysis mode
      if (recordingBlob) {
        this._liveRecordingBlob = null;
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const file = new File([recordingBlob], `live-recording-${ts}.wav`, { type: 'audio/wav' });
        await this._loadFiles([file]);
        return;
      }

      // No recording — freeze spectrogram for exploration
      if (totalSamples > 0) {
        this.spectrogram.totalSamples = totalSamples;
        this.spectrogram.wavInfo = { sampleRate: sr, numChannels: 1, bitsPerSample: 16 };
        this.spectrogram.viewStart = 0;
        this.spectrogram.viewEnd = totalSamples;
      }
    }

    // If no files loaded and no frozen spectrogram, show drop zone
    if (!this.wavInfos || this.wavInfos.length === 0) {
      const hasFrozen = !!this.spectrogram?._lastBitmap;
      if (!hasFrozen) {
        document.getElementById('main-ui').style.display = 'none';
        document.getElementById('drop-zone').style.display = '';
      }
    }

    this._updateUI();
    this._setStatus('Live stopped — explore the spectrogram');
  }

  _toggleLiveRecord() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;
    const btn = document.getElementById('btn-live-record');

    if (this._liveCapture.isRecording) {
      this._liveRecordingBlob = this._liveCapture.stopRecording();
      btn.classList.remove('recording');
      btn.firstChild.textContent = '\u25CF';
      btn.querySelector('.btn-label').textContent = ' Rec';
    } else {
      this._liveCapture.startRecording();
      btn.classList.add('recording');
      btn.firstChild.textContent = '\u25A0';
      btn.querySelector('.btn-label').textContent = ' Stop';
      this._liveRecordingBlob = null;
    }
    this._updateUI();
  }

  _saveLiveRecording() {
    if (!this._liveRecordingBlob) return;
    const url = URL.createObjectURL(this._liveRecordingBlob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `live-recording-${ts}.wav`;
    a.click();
    URL.revokeObjectURL(url);
    this._setStatus('Recording saved');
  }

  _updateLiveStatus() {
    if (!this._liveCapture || !this._liveCapture.isCapturing) return;
    const sr = this._liveCapture.sampleRate;
    const totalSec = this._liveCapture.totalSamples / sr;
    const status = document.getElementById('live-status');
    const rec = this._liveCapture.isRecording;
    status.textContent = `${sr} Hz | ${this._formatTime(totalSec)}${rec ? ' | REC' : ''}`;

    // Update info strip
    document.getElementById('info-file').textContent = `Live ${sr} Hz`;
    document.getElementById('info-duration').textContent = `DUR ${this._formatTime(totalSec)}`;

    requestAnimationFrame(() => this._updateLiveStatus());
  }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

// --- Service Worker registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // Check for updates every 5 minutes
      setInterval(() => reg.update(), 5 * 60 * 1000);

      // A new SW is waiting — show update banner
      const showUpdateBanner = () => {
        const banner = document.getElementById('update-banner');
        if (banner) banner.style.display = '';

        const btnUpdate = document.getElementById('btn-update');
        if (btnUpdate) {
          btnUpdate.onclick = () => {
            if (reg.waiting) {
              reg.waiting.postMessage({ type: 'SKIP_WAITING' });
            }
          };
        }
        const btnDismiss = document.getElementById('btn-dismiss-update');
        if (btnDismiss) {
          btnDismiss.onclick = () => {
            if (banner) banner.style.display = 'none';
          };
        }
      };

      if (reg.waiting) {
        showUpdateBanner();
      }

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });
    });

    // When the new SW activates and takes over, reload the page
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    // Listen for messages from SW (e.g., version info)
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        console.log(`Service worker updated to v${event.data.version}`);
      }
    });
  });
}
