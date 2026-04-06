# Rebuild Specification

This document provides enough detail for an LLM (or human) to recreate Field Recording Explorer from scratch.

## Tech stack — exact versions

| Component | Version / Spec | Notes |
|-----------|---------------|-------|
| Electron | `^33.0.0` | Runtime (Chromium + Node 20.x) |
| electron-builder | `^25.0.0` | Packaging only (`devDependencies`) |
| Node.js | Bundled with Electron 33 | Used in main process for `fs`, `http`, `path` |
| JavaScript | ES2022 | ES modules in renderer, CommonJS in main |
| HTML/CSS | HTML5 + CSS3 | No framework, no preprocessor |
| Web Audio API | Browser-native | `MediaElementSource` → `GainNode` → `AnalyserNode` |
| Web Workers | Browser-native | FFT pool + 1 render worker |
| Canvas 2D | Browser-native | Spectrogram display |

**Runtime npm dependencies: zero.** The app ships only Electron itself.

## Complete file tree

```
field-recording-explorer/
├── package.json              App metadata, scripts, electron-builder config, .wav file association
├── main.js                   Electron main process: BrowserWindow, 13 IPC handlers, HTTP audio
│                             server (Range requests, 16-bit conversion, decimation), WAV export,
│                             file descriptor cache, WAV/BWF header parser (Node-side)
├── preload.js                Context bridge via contextBridge.exposeInMainWorld(); exposes 15
│                             methods on window.electronAPI (thin ipcRenderer.invoke wrappers)
├── index.html                Static app layout: toolbar, info strip, canvas container, bottom bar,
│                             status bar, annotation dialog, file list panel, shortcuts modal
├── src/
│   ├── app.js                App controller: instantiates Session + SpectrogramRenderer +
│   │                         AudioEngine; wires all DOM events, keyboard shortcuts, drag-drop,
│   │                         VU meter (rAF), annotations CRUD, theme toggle, playback-rate UI
│   ├── session.js            Multi-file session manager: sorts WAV/BWF files by timecode,
│   │                         stitches into unified timeline, wall-clock ↔ session-time conversion
│   ├── spectrogram.js        On-demand spectrogram: two computation modes (full / subsampled),
│   │                         Web Worker FFT pool (up to 8), tile cache (max 200), canvas drawing
│   │                         (axes, cursor, selection, annotations, file boundaries), interaction
│   │                         (zoom, pan, click-seek, drag-select, scrollbar)
│   ├── audio-engine.js       Audio playback via <audio> + Web Audio API; gain amplification
│   │                         (0–60 dB), tape-speed playback (preservesPitch=false), loop regions,
│   │                         VU meter data (peak/RMS from AnalyserNode), output device selection
│   ├── bwf-parser.js         Renderer-side RIFF/WAVE parser: fmt (incl. WAVE_FORMAT_EXTENSIBLE),
│   │                         data, bext (origination time/date, timecode reference), iXML chunks;
│   │                         time string utilities
│   ├── fft-worker.js         Web Worker: Cooley-Tukey radix-2 FFT with pre-computed twiddle
│   │                         factors + bit-reversal tables; two protocols (per-task and bulk);
│   │                         Hann windowing; magnitude output in dB
│   └── render-worker.js      Web Worker: maps FFT magnitudes to pixels using 256-entry colormap
│                             LUTs (viridis, magma, inferno, grayscale, green, hot); returns
│                             ImageBitmap via zero-copy transfer
├── styles/
│   └── main.css              Dark/light themes via CSS custom properties on :root and
│                             [data-theme="light"]; --canvas-* vars read by JS for canvas
│                             drawing; VU meter, toolbar, sidebar, modal styles
└── docs/
    ├── ARCHITECTURE.md       Module-level architecture, IPC channel reference, data flow diagrams
    ├── QUICKSTART.md         5-step beginner guide
    └── REBUILD_SPEC.md       This file
```

## Environment variables and configuration

### Environment variables

None. The application has no environment variable dependencies. All configuration is either hardcoded or set via the UI at runtime.

### Runtime configuration (UI state)

All settings are controlled via the GUI and take effect immediately. None are persisted to disk except where noted.

| Setting | Default | Persistence |
|---------|---------|-------------|
| Theme (dark/light) | `dark` | `localStorage('theme')` |
| FFT size | `2048` | In-memory only |
| Spectrogram gain | `0 dB` | In-memory only |
| Dynamic range | `90 dB` | In-memory only |
| Frequency range | `0 – Nyquist` | In-memory only |
| Log frequency scale | `off` | In-memory only |
| Color preset | `viridis` | In-memory only |
| Audio gain | `0 dB` | In-memory only |
| Volume | `1.0` | In-memory only |
| Playback rate | `1.0` | In-memory only |
| Audio output device | System default | In-memory only |
| TC offset | `0 h` | In-memory only |
| Channel | Mix (all) | In-memory only |

### Build configuration (`package.json`)

```jsonc
{
  "build": {
    "appId": "com.fieldrecording.explorer",
    "productName": "Field Recording Explorer",
    "files": ["main.js", "preload.js", "index.html", "src/**/*", "styles/**/*"],
    "fileAssociations": [{ "ext": "wav", "mimeType": "audio/wav" }],
    "mac":   { "category": "public.app-category.music" },
    "linux": { "target": ["AppImage", "deb"] },
    "win":   { "target": ["nsis", "portable"] }
  }
}
```

### Annotation file format

Annotations are saved as JSON arrays. The app autoloads from `<basename>.annotations.json` or `annotations.json` in the recording folder.

```jsonc
[
  {
    "note": "Wolf howl",
    "sessionStart": 1234.56,       // seconds in unified timeline
    "sessionEnd": 1240.12,
    "segments": [                   // per-source-file references
      {
        "fileName": "rec_001.wav",
        "filePath": "/path/to/rec_001.wav",
        "startInFile": 34.56,      // seconds from file start
        "endInFile": 40.12,
        "wallClockStart": 45678.9, // seconds from midnight (nullable)
        "wallClockEnd": 45684.5,
        "originationDate": "2024-06-15"
      }
    ],
    "wallClockStartISO": "2024-06-15T12:41:18",  // nullable
    "wallClockEndISO": "2024-06-15T12:41:24"
  }
]
```

## External dependencies and rationale

### Runtime dependencies (npm)

**None.** The entire application is built with vanilla JavaScript and browser/Node built-in APIs.

### Dev dependencies

| Package | Version | Why needed |
|---------|---------|------------|
| `electron` | `^33.0.0` | Provides the runtime: Chromium (renderer + Web Audio + Canvas + Workers) and Node.js (file I/O, HTTP server). Version 33+ required for `webUtils.getPathForFile()` which replaced the removed `File.path` for drag-and-drop. |
| `electron-builder` | `^25.0.0` | Packages the app into platform-specific distributables (macOS .app, Linux AppImage/deb, Windows NSIS/portable). Not used at runtime. |

### Node.js built-in modules used (main process)

| Module | Purpose |
|--------|---------|
| `fs` / `fs.promises` | Read WAV file headers, PCM data chunks, write exported WAVs and annotation JSON |
| `http` | Local audio streaming server (localhost, random port) serving stitched WAV with Range support |
| `path` | Resolve file paths, join directory + filename |

### Browser APIs used (renderer)

| API | Purpose |
|-----|---------|
| `Web Audio API` | Audio graph: `MediaElementSource` → `GainNode` (amplification) → `AnalyserNode` (VU meter) → `destination` |
| `<audio>` element | Streaming playback from HTTP server; `preservesPitch = false` for tape-speed behavior |
| `Canvas 2D` | Spectrogram display, axes, overlays, cursor, selection, annotation regions |
| `Web Workers` | Parallel FFT computation (pool of up to 8) + offscreen spectrogram pixel rendering |
| `ImageBitmap` | Zero-copy transfer of rendered spectrogram from render worker to main thread |
| `localStorage` | Persist theme preference (dark/light) |
| `navigator.mediaDevices` | Enumerate audio output devices for device selection dropdown |
| `requestAnimationFrame` | Playback cursor updates, VU meter animation loop |
