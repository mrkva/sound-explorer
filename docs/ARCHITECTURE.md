# Architecture

Field Recording Explorer is an Electron desktop application for reviewing, navigating, and annotating long-duration WAV field recordings via a high-resolution spectrogram. It loads single files or entire folders of WAV/BWF files, stitches them into a continuous timeline using embedded timecodes, computes FFT spectrograms on-demand using a Web Worker pool, streams audio through a local HTTP server, and provides annotation/export tools — all with zero runtime dependencies beyond Electron itself.

## Tech stack and dependencies

| Layer | Technology |
|-------|------------|
| Runtime | Electron 33 (Chromium + Node.js) |
| Build | electron-builder 25 |
| Language | Vanilla JavaScript (ES modules in renderer, CommonJS in main) |
| UI | HTML5 Canvas (spectrogram), plain DOM (controls), CSS custom properties (theming) |
| Audio | Web Audio API (`MediaElementSource` → `GainNode` → `AnalyserNode`) |
| FFT | Custom Cooley-Tukey radix-2 implementation in Web Workers |
| Rendering | Offscreen `ImageBitmap` via dedicated render worker |
| Persistence | `localStorage` (theme), JSON files (annotations) |

No npm runtime dependencies. The only `devDependencies` are `electron` and `electron-builder`.

## Directory structure

```
field-recording-explorer/
├── main.js                  Electron main process: window, IPC handlers, HTTP audio server, WAV export
├── preload.js               Context bridge: exposes IPC methods to renderer as window.electronAPI
├── index.html               Application layout: toolbar, info strip, canvas, bottom bar, modals
├── package.json             App metadata, build config, scripts (start/pack/dist/clean)
├── src/
│   ├── app.js               App controller: wires all modules, UI events, annotations, keyboard shortcuts
│   ├── session.js            Multi-file session manager: timeline stitching, wall-clock mapping
│   ├── spectrogram.js        Spectrogram renderer: on-demand FFT, worker pool, tile cache, canvas drawing
│   ├── audio-engine.js       Audio playback: Web Audio API, gain, looping, VU meter data
│   ├── bwf-parser.js         WAV/BWF header parser: fmt, bext, iXML chunk extraction
│   ├── fft-worker.js         Web Worker: parallel FFT computation (Cooley-Tukey, Hann window)
│   └── render-worker.js      Web Worker: spectrogram pixel rendering with colormap LUTs
├── styles/
│   └── main.css              Dark/light theme via CSS custom properties, all UI component styles
└── docs/
    └── ARCHITECTURE.md       This file
```

## Module details

### main.js — Electron main process

**Purpose:** Creates the BrowserWindow, handles all IPC from the renderer, runs a local HTTP server for audio streaming, reads/writes files, and exports WAV segments.

**Key functions:**

| Function / Handler | Description |
|---|---|
| `createWindow()` | Creates BrowserWindow with `contextIsolation: true`, loads `index.html` |
| `startAudioServer()` | Starts `http.createServer` on localhost, random port |
| `serveBytes(res, wavHeader, start, end)` | Streams byte ranges from stitched virtual WAV file |
| `convert16bit(srcBuf, ...)` | Converts 16/24/32-bit int or 32-bit float PCM to 16-bit with optional decimation |
| `buildWavHeader(dataSize, channels, sampleRate, bitsPerSample)` | Builds a 44-byte WAV header |
| `writeWavFromSegments(segments, outputPath, sampleRate, bextMeta)` | Shared WAV writer with optional bext chunk |
| `readWavHeader(filePath)` | Reads up to 1 MB of file, parses fmt/data/bext/iXML chunks |
| `getCachedFd(filePath)` | File descriptor cache with 10s TTL (avoids open/close per read) |

**IPC channels (all `ipcMain.handle`):**

| Channel | Args | Returns | Purpose |
|---|---|---|---|
| `open-folder-dialog` | — | `string\|null` | Native folder picker |
| `open-file-dialog` | — | `string[]\|null` | Native file picker (multi-select WAV) |
| `save-file-dialog` | `{title, defaultPath, filters}` | `string\|null` | Native save dialog |
| `write-file` | `filePath, content` | `true` | Write text file to disk |
| `read-text-file` | `filePath` | `string` | Read text file from disk |
| `scan-folder` | `folderPath` | `fileInfo[]` | List + parse all WAV headers in folder |
| `scan-files` | `filePaths[]` | `fileInfo[]` | Parse WAV headers for specific files |
| `read-file-header` | `filePath` | `{header: ArrayBuffer, fileSize}` | Read up to 1 MB header |
| `read-pcm-chunk` | `filePath, dataOffset, byteOffset, byteLength` | `ArrayBuffer` | Read contiguous PCM bytes |
| `read-pcm-scattered` | `filePath, dataOffset, windows[]` | `ArrayBuffer` | Read multiple non-contiguous byte ranges in one call |
| `setup-audio-server` | `files[], outputRate` | `{url, outputSampleRate, decimationFactor}` | Configure and start HTTP audio server |
| `export-wav-segment` | `segments[], outputPath, bextMeta` | `{success, outputPath, totalDataBytes}` | Export selection as WAV (native sample rate) |
| `export-wav-resampled` | `segments[], outputPath, targetSampleRate, bextMeta` | `{success, outputPath, totalDataBytes, targetSampleRate}` | Export WAV with modified sample rate header |

**Depends on:** `electron`, `fs`, `http`, `path` (all Node.js built-ins).

---

### preload.js — Context bridge

**Purpose:** Exposes a safe `window.electronAPI` object to the renderer using `contextBridge.exposeInMainWorld`. Each method is a thin wrapper around `ipcRenderer.invoke` for one of the IPC channels above.

**Exports (on `window.electronAPI`):** `getPathForFile`, `openFileDialog`, `saveFileDialog`, `writeFile`, `readTextFile`, `openFolderDialog`, `scanFolder`, `scanFiles`, `exportWavSegment`, `exportWavResampled`, `readFileHeader`, `readPcmChunk`, `readPcmScattered`, `setupAudioServer`, `onOpenFiles`.

**Depends on:** `electron` (`contextBridge`, `ipcRenderer`, `webUtils`).

---

### src/app.js — App controller

**Purpose:** The top-level orchestrator. Instantiates `Session`, `SpectrogramRenderer`, and `AudioEngine`. Wires all DOM events (buttons, sliders, keyboard shortcuts, drag-and-drop). Manages annotations (create, save, load, autoload, export). Handles VU meter, theme toggle, channel selection, and playback rate.

**Class:** `App` (instantiated at module load, not exported)

**Key methods:**

| Method | Description |
|---|---|
| `_initSession()` | Loads files into Session, sets up audio server, initializes spectrogram |
| `_setupEventListeners()` | Binds all toolbar buttons, sliders, keyboard shortcuts |
| `_setupDragAndDrop()` | Handles file/folder drag-and-drop via `electronAPI.getPathForFile` |
| `_startVUMeter()` | rAF loop: reads peak levels, computes dBFS, updates meter + peak hold |
| `_saveAnnotation()` | Creates annotation from selection with file refs + wall-clock times |
| `_exportSelectionAsWav()` | Exports current selection as native WAV via `exportWavSegment` |
| `_exportSelectionSlowed()` | Exports selection with modified sample rate via `exportWavResampled` |
| `_autoloadAnnotations()` | Scans recording folder for `*.annotations.json`, loads if found |
| `_buildExportSegments(ann)` | Converts annotation to byte-range segments for export |
| `_buildBextMetadata(ann)` | Builds BWF bext metadata for exported files |
| `_changePlayAsRate(speed)` | Sets playback speed (tape-speed semantics, changes pitch) |

**Depends on:** `BWFParser`, `SpectrogramRenderer`, `AudioEngine`, `Session`, `window.electronAPI`.

---

### src/session.js — Session manager

**Purpose:** Represents a multi-file recording session as a single continuous timeline. Sorts files by BWF timecode, computes cumulative sample/time offsets, and provides wall-clock ↔ session-time conversion.

**Class:** `export class Session`

**Public API:**

| Method | Description |
|---|---|
| `loadFolder(folderPath)` | Scan folder, sort by timecode, stitch into timeline |
| `loadFiles(filePaths)` | Same for explicit file list |
| `loadFile(filePath)` | Single-file session |
| `toWallClock(timeInSession)` | Session seconds → seconds-from-midnight |
| `fromWallClock(wallClockSeconds)` | Seconds-from-midnight → session seconds |
| `fileAtTime(timeInSession)` | Find which file contains a given time |
| `fileAtSample(sample)` | Find which file contains a given sample |
| `getServerFileList()` | Format file list for audio server setup |
| `getSummary()` | Human-readable session info string |

**Key fields:** `files[]`, `totalDuration`, `totalSamples`, `sampleRate`, `channels`, `bitsPerSample`, `format`, `blockAlign`, `sessionStartTime`, `sessionEndTime`, `sessionDate`.

**Depends on:** `BWFParser`, `window.electronAPI` (for `scanFolder`, `scanFiles`, `readFileHeader`).

---

### src/spectrogram.js — Spectrogram renderer

**Purpose:** The largest module. Reads PCM data from session files, computes FFT via a worker pool, caches computed tiles, renders to canvas via a render worker, and handles all mouse/scroll/touch interaction (zoom, pan, select, seek).

**Class:** `export class SpectrogramRenderer`

**Public API:**

| Method | Description |
|---|---|
| `setSession(session)` | Attach a Session, set total duration and view range |
| `computeVisible()` | Compute FFT for current view (full or subsampled mode) |
| `draw(playbackTime)` | Render cached spectrogram + axes + overlays to canvas |
| `setView(start, end)` | Set visible time range (clamps at boundaries, preserves duration) |
| `zoom(centerTime, factor)` | Zoom around a time point |
| `rerender()` | Re-render from cached FFT data (for gain/range changes) |
| `_refreshThemeColors()` | Read CSS custom properties into `this._theme` for canvas drawing |

**Two computation modes:**

1. **Full mode** (zoomed in): reads contiguous PCM range, computes overlapping FFT frames via `computeBulk` worker protocol. Hop size driven by pixel density.
2. **Subsampled mode** (zoomed out, >16 MB of data): uses `read-pcm-scattered` IPC to read only small N-sample windows at evenly spaced positions. Transfers ~20 MB instead of ~4 GB for 30-minute views.

**Worker pool:** `min(navigator.hardwareConcurrency, 8)` FFT workers + 1 render worker.

**Tile cache:** Keyed by `startSample-endSample-fftSize-targetFrames-ch{channel}`. Max 200 tiles, LRU eviction of oldest 50.

**Depends on:** `Session` (via `this.session`), `window.electronAPI` (`readPcmChunk`, `readPcmScattered`), `fft-worker.js`, `render-worker.js`.

---

### src/audio-engine.js — Audio playback

**Purpose:** Manages an `<audio>` element connected to the local HTTP server through Web Audio API for gain control and level metering.

**Class:** `export class AudioEngine`

**Public API:**

| Method | Description |
|---|---|
| `init(sampleRate)` | Create AudioContext, wire `<audio>` → GainNode → AnalyserNode → destination |
| `setSource(url, knownDuration, sampleRate)` | Point audio at HTTP server URL |
| `play()` / `pause()` / `stop()` | Transport controls |
| `seek(time)` | Seek to position |
| `setVolume(value)` | Set volume 0–1 |
| `setGainDB(db)` | Set amplification (0 to +60 dB) |
| `setPlaybackRate(rate)` | Tape-speed playback (`preservesPitch = false`) |
| `getLevels()` | Returns `{peak, rms}` from AnalyserNode for VU meter |
| `setLoop(start, end)` / `clearLoop()` | Loop region (checked each rAF frame) |
| `setSinkId(deviceId)` | Set audio output device |

**Callbacks:** `onTimeUpdate(currentTime)`, `onEnded()`.

**Depends on:** Web Audio API, HTML5 `<audio>` element. No imports.

---

### src/bwf-parser.js — WAV/BWF header parser

**Purpose:** Parses RIFF/WAVE file headers from an ArrayBuffer. Extracts audio format info, data chunk location, and BWF metadata (bext chunk timecodes, iXML timecodes).

**Class:** `export class BWFParser` (all static methods)

**Public API:**

| Method | Description |
|---|---|
| `parse(arrayBuffer)` | Parse header → `{format, sampleRate, channels, bitsPerSample, dataOffset, dataSize, bext, originationTime, originationDate, startTimeOfDay, ...}` |
| `secondsToTimeString(seconds)` | Format seconds as `H:MM:SS` |
| `parseTimeString(timeStr)` | Parse `HH:MM:SS` → seconds from midnight |

**Supported chunks:** `fmt ` (including WAVE_FORMAT_EXTENSIBLE), `data`, `bext` (BWF v0), `iXML`.

**Depends on:** Nothing (pure parser).

---

### src/fft-worker.js — FFT Web Worker

**Purpose:** Runs in a Web Worker thread. Performs Cooley-Tukey radix-2 FFT with Hann windowing and returns magnitude spectra in dB.

**Message protocols:**

| Input type | Description | Output type |
|---|---|---|
| `compute` | Per-task: `{tasks: [{data, windowFunc}], fftSize}` | `result` → `{magnitudes: [Float32Array]}` |
| `computeBulk` | Bulk: `{pcm, fftSize, hopSize, windowFunc, startFrame, numFrames}` | `bulkResult` → `{magnitudes: [Float32Array]}` (transferred) |

**Optimizations:** Pre-computed twiddle factor tables and bit-reversal tables, cached per FFT size.

**Depends on:** Nothing (self-contained worker).

---

### src/render-worker.js — Spectrogram pixel renderer

**Purpose:** Runs in a Web Worker thread. Converts FFT magnitude frames into an `ImageBitmap` using colormap lookup tables. Handles frequency-to-pixel mapping (linear or logarithmic) and gain/dynamic-range application.

**Message protocol:**

| Input | Output |
|---|---|
| `{type: 'render', frames, freqBins, numFrames, width, height, sampleRate, fftSize, minFreq, maxFreq, logFrequency, gainDB, dynamicRangeDB, colorPreset}` | `{type: 'rendered', bitmap: ImageBitmap}` (transferred, zero-copy) |

**Colormaps:** viridis, magma, inferno, grayscale, green, hot. Each uses a 256-entry pre-built LUT.

**Depends on:** Nothing (self-contained worker).

---

### styles/main.css — Theming and layout

**Purpose:** All visual styling. Uses CSS custom properties for theming so both UI elements and canvas drawing colors can be swapped between dark and light modes.

**Theme structure:**
- `:root` — Dark theme (default). Deep blacks (#111), muted pastels, LOM-inspired.
- `[data-theme="light"]` — Light theme. White backgrounds, dark text, same accent hues.
- Canvas variables (`--canvas-*`) — Read by `spectrogram.js` via `getComputedStyle` for canvas drawing.

**Theme toggle:** `app.js` sets `data-theme` attribute on `<html>`, saves to `localStorage`, calls `spectrogram._refreshThemeColors()`.

---

### index.html — Application layout

**Purpose:** Static HTML structure. No framework, no templating. All dynamic behavior is in `app.js`.

**Layout (top to bottom):**
1. **Toolbar** — Open Folder/File, Play/Stop, Play-as rate, Zoom controls, time navigation, selection actions (From/To/Dur/Annotate/Export WAV/Export Slowed), Annotations toggle, Theme toggle, Shortcuts help
2. **Info strip** — POS, WALL, DUR, CUR (freq+time), OUT (playback format), TC offset, file info
3. **Main content** — Canvas (spectrogram) + scrollbar + overlays (welcome, computing progress) | Annotations sidebar
4. **Bottom bar** — Audio (gain, volume, VU meter, output device) | Spectrogram (gain, range, FFT, colors, channel) | Frequency (min, max, preset, log)
5. **Status bar** — Single-line status text
6. **Modals** — Annotation dialog, file list panel, keyboard shortcuts

---

## Data flow

### Opening a folder and viewing spectrogram

```
User clicks "Open Folder"
  │
  ▼
App._openFolder()
  │  calls electronAPI.openFolderDialog()
  │     → IPC → main.js dialog.showOpenDialog()
  │     ← returns folderPath
  │
  ▼
App._initSession()
  │  Session.loadFolder(folderPath)
  │     calls electronAPI.scanFolder(folderPath)
  │        → IPC → main.js: readWavHeader() for each .wav file
  │        ← returns [{filePath, sampleRate, channels, bitsPerSample, dataOffset, dataSize, bext, startTimeOfDay, ...}]
  │     sorts by BWF timecode, computes cumulative timeStart/sampleStart
  │
  │  calls electronAPI.setupAudioServer(files, outputRate)
  │     → IPC → main.js: configures HTTP server, computes decimation
  │     ← returns {url: "http://127.0.0.1:<port>/audio", outputSampleRate, decimationFactor}
  │
  │  AudioEngine.setSource(url, duration, sampleRate)
  │     creates <audio> element, connects Web Audio graph
  │
  │  SpectrogramRenderer.setSession(session)
  │     sets totalDuration, viewStart=0, viewEnd=totalDuration
  │
  ▼
SpectrogramRenderer.computeVisible()
  │
  ├─ IF zoomed in (data < 16MB): FULL MODE
  │     calls electronAPI.readPcmChunk() for each file in view
  │        → IPC → main.js: reads bytes from file via cached FD
  │        ← returns ArrayBuffer of raw PCM
  │     decodes PCM → Float32Array (mono mix or single channel)
  │     distributes frames to FFT worker pool (computeBulk protocol)
  │        → workers: Hann window → FFT → magnitude dB
  │        ← returns Float32Array[] of spectra
  │
  ├─ IF zoomed out (data ≥ 16MB): SUBSAMPLED MODE
  │     computes evenly-spaced window positions (step = totalSpan / targetFrames)
  │     calls electronAPI.readPcmScattered(filePath, dataOffset, windows[])
  │        → IPC → main.js: reads only N-sample windows, packs into single buffer
  │        ← returns compact ArrayBuffer (~20MB vs ~4GB)
  │     decodes each window, sends to FFT workers (compute protocol)
  │
  ▼
FFT results cached as tile (key: sampleRange + fftSize + channel)
  │
  ▼
SpectrogramRenderer._renderSpectrogram(data)
  │  sends {frames, freqBins, width, height, gainDB, dynamicRangeDB, colorPreset, ...}
  │     → render-worker.js: maps bins to pixels, applies colormap LUT
  │     ← returns ImageBitmap (zero-copy transfer)
  │
  ▼
SpectrogramRenderer.draw()
  │  ctx.drawImage(bitmap)              — spectrogram pixels
  │  _drawFrequencyAxis()               — Hz labels on left
  │  _drawTimeAxis()                    — time labels + wall-clock on bottom
  │  _drawFileBoundaries()              — dashed lines between files
  │  _drawAnnotationRegions()           — colored overlays with stacked labels
  │  draws playback cursor, selection highlight
```

### Audio playback

```
User clicks Play
  │
  ▼
AudioEngine.play()
  │  <audio>.play() → HTTP Range request to localhost server
  │     → main.js serveBytes(): reads source PCM, converts to 16-bit,
  │       decimates if needed, streams via chunked response
  │  starts rAF loop: onTimeUpdate(currentTime)
  │     → App updates time displays, spectrogram cursor, auto-scroll
  │
  │  If loop region set: checks currentTime >= loopEnd, seeks to loopStart
  │
  ▼
VU meter (separate rAF loop in App._startVUMeter):
  AudioEngine.getLevels()
     → AnalyserNode.getFloatTimeDomainData()
     → compute peak → dBFS → update meter width, peak hold, dBFS readout
```

### Exporting a selection

```
User selects range (drag on spectrogram) → App._onSelectionMade → shows toolbar, starts loop

Export WAV:
  _getSelectionSegments() maps session time → per-file byte ranges
  _buildExportSegments() converts to {filePath, dataOffset, startByte, endByte, ...}
  electronAPI.exportWavSegment(segments, outputPath, bextMeta)
    → main.js writeWavFromSegments(): writes RIFF+bext header, copies raw PCM in 4MB chunks
    (no transcoding — bit-perfect copy at original format)

Export Slowed (speed-shifted):
  electronAPI.exportWavResampled(segments, outputPath, targetSampleRate, bextMeta)
    same PCM copy, but WAV header declares different sample rate
    → any player reads it at the new rate = pitch/speed shift
```

### Annotation persistence

```
Save:  JSON.stringify(annotations) → electronAPI.writeFile() + generates ffmpeg shell script
Load:  electronAPI.readTextFile() → JSON.parse() → populates annotations[] + spectrogram overlays
Autoload: on session init, checks folder for <basename>.annotations.json or annotations.json
```
