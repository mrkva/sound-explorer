# Architecture

Sound Explorer is a spectrogram viewer and audio player for field recordings. It exists as two applications sharing a common core: a **web app** (browser-based PWA) and a **desktop app** (Electron). Both compute FFT spectrograms on-demand using Web Worker pools, render via colormap lookup tables, and provide tape-speed playback, annotation, and export tools -- all with zero runtime dependencies beyond Electron itself (desktop) or the browser (web).

## Tech stack

| Layer | Desktop (Electron) | Web (Browser) |
|-------|-------------------|---------------|
| Runtime | Electron 33 (Chromium + Node.js) | Any modern browser |
| Build | electron-builder 25 | None (static files) |
| Language | Vanilla JavaScript (ES modules in renderer, CommonJS in main) | Vanilla JavaScript (ES modules) |
| UI | HTML5 Canvas + plain DOM + CSS custom properties | Same |
| Audio | Web Audio API (`MediaElementSource` / `MediaStreamSource`) | Same |
| FFT | Custom Cooley-Tukey radix-2 in Web Workers | Same |
| Rendering | Colormap LUT pixel mapping (render worker + live main-thread) | Same |
| Persistence | `localStorage` (theme), JSON files (annotations) | `localStorage` (theme), in-memory (annotations exportable as JSON) |
| Offline | Native app | Service worker (PWA) |

No npm runtime dependencies in either version.

## Repository structure

```
sound-explorer/
├── README.md                    Project overview, features, running instructions
├── docs/
│   ├── ARCHITECTURE.md          This file
│   ├── QUICKSTART.md            Getting started guide for both versions
│   ├── REBUILD_SPEC.md          Detailed rebuild specification (desktop)
│   └── WEB_APP.md               Web app specifics and differences from desktop
├── apps/
│   ├── desktop/                 Electron desktop application
│   │   ├── main.js              Electron main process: IPC, HTTP audio server, file I/O
│   │   ├── preload.js           Context bridge: exposes IPC methods as window.electronAPI
│   │   ├── index.html           Application layout
│   │   ├── package.json         Scripts (start/pack/dist/clean), electron-builder config
│   │   ├── src/
│   │   │   ├── app.js           App controller: UI events, annotations, keyboard, VU meter
│   │   │   ├── session.js       Multi-file session manager: timeline stitching, wall-clock
│   │   │   ├── spectrogram.js   Spectrogram renderer: FFT, worker pool, tile cache, canvas
│   │   │   ├── audio-engine.js  Audio playback: Web Audio, gain, looping, VU metering
│   │   │   ├── bwf-parser.js    WAV/BWF header parser: fmt, bext, iXML chunks
│   │   │   ├── fft-worker.js    Web Worker: parallel FFT (Cooley-Tukey, Hann window)
│   │   │   ├── fft-core.js      Shared FFT primitives (window functions, FFT, magnitudes)
│   │   │   ├── render-worker.js Web Worker: spectrogram pixel rendering with colormap LUTs
│   │   │   ├── colormaps.js     Colormap definitions and LUT builder
│   │   │   ├── ixml.js          iXML metadata parsing and serialization
│   │   │   ├── frm.js           Field Recording Metadata sidecar parsing
│   │   │   └── live-capture.js  Live audio capture via getUserMedia + AudioWorklet
│   │   ├── styles/
│   │   │   └── main.css         Dark/light themes via CSS custom properties
│   │   └── README.md            Desktop-specific documentation
│   │
│   └── web/                     Browser application (PWA)
│       ├── index.html           Application layout
│       ├── manifest.json        PWA manifest (standalone display)
│       ├── sw.js                Service worker: app shell caching, update notifications
│       ├── js/
│       │   ├── app.js           App controller: file handling, UI, live mode, VU meter
│       │   ├── spectrogram.js   Spectrogram renderer: FFT, worker pool, tile cache, canvas
│       │   ├── audio-engine.js  Audio playback: Web Audio, gain, VU metering
│       │   ├── wav-parser.js    WAV/BWF parser (browser File API, no Node.js)
│       │   ├── fft-worker.js    Web Worker: parallel FFT
│       │   ├── fft-core.js      Shared FFT primitives
│       │   ├── render-worker.js Web Worker: spectrogram pixel rendering
│       │   ├── colormaps.js     Colormap definitions and LUT builder
│       │   ├── ixml.js          iXML metadata parsing and serialization
│       │   ├── frm.js           Field Recording Metadata sidecar parsing
│       │   ├── live-capture.js  Live audio capture via getUserMedia + AudioWorklet
│       │   └── version.js       App version string
│       ├── css/
│       │   └── main.css         Dark/light themes via CSS custom properties
│       ├── img/                 Icons and logos (SVG, PNG)
│       └── README.md            Web-specific documentation
```

## Shared code

Both apps use the same core modules, kept as local copies (not shared via npm):

| Module | Purpose |
|--------|---------|
| `fft-core.js` | Window functions (Hann, Hamming, Blackman, etc.), Cooley-Tukey radix-2 FFT, magnitude computation |
| `colormaps.js` | Six colormap definitions (viridis, magma, inferno, grayscale, green, hot) and `buildColorLUT()` for 256-entry RGBA lookup tables |
| `fft-worker.js` | Web Worker: receives PCM data, applies windowing, computes FFT, returns magnitude spectra in dB |
| `render-worker.js` | Web Worker: converts FFT magnitudes to spectrogram pixels via colormap LUT, returns ImageBitmap |
| `ixml.js` | Parses and serializes iXML metadata embedded in WAV files |
| `frm.js` | Parses and serializes Field Recording Metadata (FRM) text sidecar files |
| `live-capture.js` | Captures live audio via `getUserMedia` + AudioWorklet (ScriptProcessor fallback), ring buffer for spectrogram, optional recording to WAV |

## Desktop app modules

### main.js -- Electron main process

Creates the BrowserWindow, handles all IPC from the renderer, runs a local HTTP server for audio streaming, reads/writes files, and exports WAV segments.

**IPC channels (all `ipcMain.handle`):**

| Channel | Purpose |
|---|---|
| `open-folder-dialog` | Native folder picker |
| `open-file-dialog` | Native file picker (multi-select WAV) |
| `save-file-dialog` | Native save dialog |
| `write-file` | Write text file to disk |
| `read-text-file` | Read text file from disk |
| `scan-folder` | List + parse all WAV headers in folder |
| `scan-files` | Parse WAV headers for specific files |
| `read-file-header` | Read up to 1 MB header |
| `read-pcm-chunk` | Read contiguous PCM bytes |
| `read-pcm-scattered` | Read multiple non-contiguous byte ranges in one call |
| `setup-audio-server` | Configure and start HTTP audio server |
| `export-wav-segment` | Export selection as WAV (native sample rate) |
| `export-wav-resampled` | Export WAV with modified sample rate header |

### preload.js -- Context bridge

Exposes a safe `window.electronAPI` object to the renderer using `contextBridge.exposeInMainWorld`. Each method wraps `ipcRenderer.invoke` for one of the IPC channels.

### src/session.js -- Session manager

Represents a multi-file recording session as a single continuous timeline. Sorts files by BWF timecode, computes cumulative sample/time offsets, provides wall-clock <-> session-time conversion. Desktop-only -- the web app operates on individual files.

### src/bwf-parser.js -- WAV/BWF header parser

Parses RIFF/WAVE headers from ArrayBuffer. Extracts format info, data chunk location, BWF metadata (bext timecodes, iXML). Desktop-only (the web app uses `wav-parser.js` which reads via File API).

### src/spectrogram.js -- Spectrogram renderer

The largest module. Two computation modes:

1. **Full mode** (zoomed in): reads contiguous PCM, computes overlapping FFT frames via worker pool.
2. **Subsampled mode** (zoomed out, >16 MB): uses scattered reads to sample small windows at evenly spaced positions. Transfers ~20 MB instead of ~4 GB for 30-minute views.

Also handles live spectrogram rendering using a pre-built color LUT for performance (256-entry table lookup instead of per-pixel colormap interpolation).

**Worker pool:** `min(navigator.hardwareConcurrency, 8)` FFT workers + 1 render worker.

**Tile cache:** Keyed by `startSample-endSample-fftSize-targetFrames-ch{channel}`. Max 200 tiles, LRU eviction.

### src/audio-engine.js -- Audio playback

Manages `<audio>` element connected to the local HTTP server through Web Audio API for gain control, tape-speed playback (`preservesPitch = false`), loop regions, and level metering.

### src/app.js -- App controller

Top-level orchestrator. Instantiates Session, SpectrogramRenderer, AudioEngine. Wires DOM events, keyboard shortcuts, drag-and-drop, annotations, VU meter, theme toggle, live capture, and context-aware toolbar via `_updateUI()`.

## Web app modules

See [WEB_APP.md](WEB_APP.md) for detailed web-specific documentation.

The web app controller (`js/app.js`) manages a unified file/live experience with a declarative `_updateUI()` method that shows/hides controls based on app state (hasFile, isLive, isFrozen, hasRecording). Key differences from desktop:

- **No Session class** -- operates on individual files via File API
- **`wav-parser.js`** instead of `bwf-parser.js` -- reads WAV headers from browser `File` objects
- **Service worker** (`sw.js`) -- caches app shell for offline PWA use
- **Mobile-optimized** -- touch crosshair with frequency/time labels, long-press for selection, responsive toolbar
- **Ballistic VU meter** -- instant attack, 80 dB/s decay using `clip-path` rendering

## Data flow

### Opening a file (desktop)

```
User opens folder/files
  -> App._initSession()
  -> Session.loadFolder/loadFiles()
     -> electronAPI.scanFolder() -> IPC -> main.js reads WAV headers
     -> sorts by BWF timecode, stitches timeline
  -> electronAPI.setupAudioServer() -> starts HTTP server
  -> AudioEngine.setSource(url)
  -> SpectrogramRenderer.setSession()
  -> computeVisible()
     -> readPcmChunk/readPcmScattered via IPC
     -> FFT worker pool -> magnitude spectra
     -> render worker -> ImageBitmap (zero-copy transfer)
  -> draw() -> canvas
```

### Opening a file (web)

```
User drops/selects file
  -> App._loadFiles()
  -> WavParser reads header via file.slice()
  -> SpectrogramRenderer.loadFile()
  -> computeVisible()
     -> file.slice() reads PCM chunks
     -> FFT worker pool -> magnitude spectra
     -> render worker -> ImageBitmap
  -> draw() -> canvas
```

### Live capture (both apps)

```
User clicks "Live"
  -> LiveCapture.start(deviceId)
     -> getUserMedia -> AudioWorklet -> ring buffer
  -> spectrogram.setLiveSource(liveCapture)
  -> _liveRenderLoop() (requestAnimationFrame)
     -> read new samples from ring buffer
     -> compute FFT for new columns
     -> _renderLiveFrame() using color LUT (256-entry table)
     -> draw() -> canvas
```

### Audio playback

```
Desktop: <audio> -> HTTP Range request -> main.js serves PCM (16-bit, decimated)
Web:     <audio> -> WAV blob URL (speed baked into header sample rate)

Both: MediaElementSource -> GainNode -> AnalyserNode -> destination
      rAF loop reads AnalyserNode for VU meter
```

## Live capture

Both apps support real-time audio capture via `LiveCapture`:

- **Ring buffer** -- keeps last 30 seconds of audio in a circular Float32Array
- **Recording** -- optionally records all captured audio (grows unbounded) for WAV export
- **AudioWorklet** with ScriptProcessor fallback for older browsers
- **Device selection** -- enumerates input devices via `navigator.mediaDevices`
- **VU metering** -- peak and RMS computed per audio block

The spectrogram live renderer uses:
- Pre-built **256-entry color LUT** for fast pixel mapping (avoids per-pixel colormap interpolation)
- **Reused ImageData buffer** to avoid GC pressure
- **Y-bin mapping cache** for frequency-to-pixel conversion (invalidated on frequency range or scale changes)
- **Column cache** (circular buffer) so only new FFT columns are computed each frame

## Theming

Both apps use CSS custom properties for dark/light themes:
- `:root` -- dark theme (default)
- `[data-theme="light"]` -- light theme
- `--canvas-*` variables read by JavaScript for canvas drawing colors
- Theme preference saved to `localStorage`
