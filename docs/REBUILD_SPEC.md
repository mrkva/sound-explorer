# Rebuild Specification

This document provides enough detail for an LLM (or human) to recreate the Sound Explorer desktop app from scratch. For the web app, see [WEB_APP.md](WEB_APP.md).

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
sound-explorer/apps/desktop/
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
│   │                         VU meter (rAF), annotations CRUD, theme toggle, live capture,
│   │                         metadata forms, playback-rate UI, context-aware _updateUI()
│   ├── session.js            Multi-file session manager: sorts WAV/BWF files by timecode,
│   │                         stitches into unified timeline, wall-clock ↔ session-time conversion
│   ├── spectrogram.js        On-demand spectrogram: two computation modes (full / subsampled),
│   │                         Web Worker FFT pool (up to 8), tile cache (max 200), canvas drawing
│   │                         (axes, cursor, selection, annotations, file boundaries), interaction
│   │                         (zoom, pan, click-seek, drag-select, scrollbar), live spectrogram
│   │                         rendering with color LUT
│   ├── audio-engine.js       Audio playback via <audio> + Web Audio API; gain amplification
│   │                         (0–60 dB), tape-speed playback (preservesPitch=false), loop regions,
│   │                         VU meter data (peak/RMS from AnalyserNode), output device selection
│   ├── bwf-parser.js         Renderer-side RIFF/WAVE parser: fmt (incl. WAVE_FORMAT_EXTENSIBLE),
│   │                         data, bext (origination time/date, timecode reference), iXML chunks;
│   │                         time string utilities
│   ├── fft-core.js           Shared FFT primitives: window functions (Hann, Hamming,
│   │                         Blackman-Harris, Flat-top), Cooley-Tukey FFT, magnitude computation
│   ├── fft-worker.js         Web Worker: parallel FFT with pre-computed twiddle factors +
│   │                         bit-reversal tables; two protocols (per-task and bulk); configurable
│   │                         window function; magnitude output in dB
│   ├── render-worker.js      Web Worker: maps FFT magnitudes to pixels using 256-entry colormap
│   │                         LUTs (viridis, magma, inferno, grayscale, green, hot); returns
│   │                         ImageBitmap via zero-copy transfer
│   ├── colormaps.js          Six colormap definitions and buildColorLUT() for 256-entry RGBA tables
│   ├── ixml.js               iXML metadata parsing and serialization
│   ├── frm.js                Field Recording Metadata (FRM) sidecar parsing and serialization
│   └── live-capture.js       Live audio capture via getUserMedia + AudioWorklet; ring buffer
│                             for spectrogram display, optional recording for WAV export
├── styles/
│   └── main.css              Dark/light themes via CSS custom properties on :root and
│                             [data-theme="light"]; --canvas-* vars read by JS for canvas
│                             drawing; VU meter, toolbar, sidebar, modal styles
└── README.md                 Desktop-specific documentation
```

Shared documentation lives at the repository root in `docs/` (ARCHITECTURE.md, QUICKSTART.md, REBUILD_SPEC.md, WEB_APP.md).

## Environment variables and configuration

### Environment variables

None. The application has no environment variable dependencies. All configuration is either hardcoded or set via the UI at runtime.

### Runtime configuration (UI state)

All settings are controlled via the GUI and take effect immediately. None are persisted to disk except where noted.

| Setting | Default | Persistence |
|---------|---------|-------------|
| Theme (dark/light) | `dark` | `localStorage('theme')` |
| FFT size | `2048` | In-memory only |
| FFT window function | `hann` | In-memory only |
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
| Input gain (live) | `0 dB` | In-memory only |
| Live view window | `10 s` | In-memory only |

### Build configuration (`package.json`)

```jsonc
{
  "build": {
    "appId": "com.lom.sound-explorer",
    "productName": "Sound Explorer",
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
| `navigator.mediaDevices` | Enumerate audio output devices; `getUserMedia()` for live audio capture |
| `AudioWorklet` | Low-latency audio capture processing (ScriptProcessor fallback) |
| `requestAnimationFrame` | Playback cursor updates, VU meter animation loop, live spectrogram rendering |

## Data models / schemas

### Session (src/session.js)

```
Session {
  files: FileDescriptor[]    // sorted by BWF timecode, then filename
  totalDuration: number      // seconds (sum of all file durations)
  totalSamples: number
  sampleRate: number         // e.g. 48000
  channels: number           // e.g. 2
  bitsPerSample: number      // 16 | 24 | 32
  format: number             // 1 = PCM integer, 3 = IEEE float
  bytesPerSample: number     // bitsPerSample / 8
  blockAlign: number         // channels × bytesPerSample
  sessionStartTime: number|null  // wall-clock seconds from midnight
  sessionEndTime: number|null
  sessionDate: string|null       // "YYYY-MM-DD" or "YYYY:MM:DD"
}
```

### FileDescriptor (element of Session.files)

```
FileDescriptor {
  filePath: string           // absolute OS path
  fileName: string           // basename only
  dataOffset: number         // byte offset of PCM data chunk in file
  dataSize: number           // byte length of PCM data
  samples: number            // dataSize / blockAlign
  duration: number           // samples / sampleRate
  sampleStart: number        // cumulative sample offset in unified timeline
  timeStart: number          // cumulative time offset (seconds) in unified timeline
  wallClockStart: number|null  // seconds from midnight (from bext or iXML)
  originationDate: string|null // "YYYY-MM-DD"
  originationTime: string|null // "HH:MM:SS"
  bext: BextData|null
}
```

### BextData (BWF metadata)

```
BextData {
  description: string          // 256 chars max
  originator: string           // 32 chars max
  originatorReference: string  // 32 chars max
  originationDate: string      // "YYYY-MM-DD" (10 chars)
  originationTime: string      // "HH:MM:SS" (8 chars)
  timeReference: number        // uint64: sample count since midnight
}
```

### BWFParser.parse() result

```
ParseResult {
  format: number             // 1=PCM, 3=float (resolved from EXTENSIBLE if needed)
  sampleRate: number
  channels: number
  bitsPerSample: number      // container size (NOT validBitsPerSample)
  dataOffset: number         // byte offset of data chunk payload
  dataSize: number
  duration: number
  bext: BextData|null
  ixml: string|null          // raw iXML string (up to 8192 chars)
  originationTime: string|null
  originationDate: string|null
  timecodeReference: number  // sample count from midnight
  startTimeOfDay: number|null // seconds from midnight (computed)
}
```

### SpectrogramTile (tile cache value)

```
SpectrogramTile {
  frames: Float32Array[]     // one array per FFT frame; each has freqBins magnitudes in dB
  freqBins: number           // fftSize / 2
  numFrames: number
  hopSize: number            // samples between frames
}
// Cache key: "${startSample}-${endSample}-${fftSize}-${targetFrames}-ch${channel}"
// Max 200 tiles; evicts oldest 50 when full
```

### Annotation (in-memory and JSON)

```
Annotation {
  note: string
  sessionStart: number          // seconds in unified timeline
  sessionEnd: number
  segments: AnnotationSegment[]
  wallClockStartISO: string|null  // "YYYY-MM-DDTHH:MM:SS"
  wallClockEndISO: string|null
}

AnnotationSegment {
  fileName: string
  filePath: string
  startInFile: number          // seconds from file start
  endInFile: number
  wallClockStart: number|null  // seconds from midnight
  wallClockEnd: number|null
  originationDate: string|null
}
```

## Key algorithms and business logic

### 1. Multi-file timeline stitching

```
SORT files by:
  IF both have bext startTimeOfDay → sort by time
    (midnight crossing: if |timeA - timeB| > 12h, subtract 86400 from the larger)
  ELSE → sort by filename (lexicographic)

FOR each file (in sorted order):
  SKIP if sampleRate/channels/bitsPerSample differs from first file
  file.sampleStart = cumulative total samples so far
  file.timeStart   = cumulative total seconds so far
  totalSamples += file.samples
  totalDuration += file.duration
```

### 2. Spectrogram computation mode selection

```
targetFrames = min(canvasPixelWidth × 2, 4000)
hopSize = max(64, floor(viewSamples / targetFrames))
samplesNeeded = targetFrames × hopSize + fftSize

IF viewSamples > samplesNeeded × 1.5  OR  viewSamples > 16M:
  USE subsampled mode
ELSE:
  USE full mode
```

### 3. Subsampled spectrogram (wide views)

```
step = floor(totalViewSpan / targetFrames)
FOR each file overlapping the view:
  positions[] = evenly-spaced sample offsets within file (every `step` samples)
  BATCH positions into groups of ≤2000
  IPC read-pcm-scattered(file, dataOffset, windows[{byteOffset, byteLength=fftSize×blockAlign}])
    → returns concatenated raw bytes (single IPC call per batch)
  Decode each window → Float32Array (mono mix or single channel)
  Send batches to FFT worker pool (computeBulk protocol)
Fill gaps between files with -120 dB silence
```

### 4. FFT (Cooley-Tukey radix-2, in fft-core.js / fft-worker.js)

```
PRE-COMPUTE (cached per fftSize N):
  twiddle[i] = { cos(-2πi/N), sin(-2πi/N) }  for i in [0, N/2)
  bitrev[i] = bit-reversed index              for i in [0, N)

WINDOW (user-selectable via fft-core.js getWindow()):
  Hann:            w[i] = 0.5 × (1 - cos(2πi/(N-1)))
  Hamming:         w[i] = 0.54 - 0.46 × cos(2πi/(N-1))
  Blackman-Harris: w[i] = 0.35875 - 0.48829×cos(2πi/(N-1)) + 0.14128×cos(4πi/(N-1)) - 0.01168×cos(6πi/(N-1))
  Flat-top:        w[i] = 1 - 1.93×cos(2πi/(N-1)) + 1.29×cos(4πi/(N-1)) - 0.388×cos(6πi/(N-1)) + 0.0322×cos(8πi/(N-1))

FFT(input, N):
  Apply bit-reversal permutation → out[2×N] (interleaved re,im)
  FOR stage s = 1..log2(N):
    butterfly with pre-computed twiddles (stride = N >> s)
  RETURN interleaved complex array

MAGNITUDES(spectrum, N):
  FOR each bin j in [0, N/2):
    mag = sqrt(re² + im²)
    dB = 20 × log10(max(mag, 1e-10))
    IF !isFinite(dB): dB = -120
```

### 5. Spectrogram pixel rendering (render-worker.js)

```
Build 256-entry colormap LUT from preset stops (linear interpolation)
Compute Y→bin lookup table:
  IF log frequency: bin = exp(logMin + ratio × (logMax-logMin)) / binRes
  ELSE:             bin = minBin + ratio × visibleBins
  Store floor(bin) and fractional part for interpolation

FOR each pixel (x, y):
  frameIdx = floor(x × numFrames / width)
  Interpolate between adjacent bins using fractional lookup
  dB = raw + gainDB
  lutIdx = clamp(round((dB - floor) × 255/dynamicRange), 0, 255)
  pixel = LUT[lutIdx]

Convert ImageData → ImageBitmap (zero-copy transfer to main thread)
```

### 6. HTTP audio server (main.js)

```
Server presents all session files as ONE virtual WAV file:
  Total size = 44-byte header + totalDataBytes (16-bit output)
  Output is ALWAYS 16-bit PCM at outputSampleRate (≤48kHz)
  decimationFactor = round(sourceSampleRate / targetRate)

ON request:
  Parse Range header → start, end bytes
  IF byte range overlaps WAV header (bytes 0-43): serve header bytes
  FOR each session file overlapping the data range:
    Map output byte offset → source sample offset (× decimationFactor)
    Read source PCM in ≤2MB chunks
    convert16bit(): handles 16/24/32-int and 32-float → 16-bit
      With decimation: takes every D-th sample (no filter, simple skip)
    Stream converted chunks to response
```

### 7. VU meter (app.js)

```
rAF loop (60fps):
  IF playing:
    peak = max(|sample|) from AnalyserNode.getFloatTimeDomainData(256 samples)
    dBFS = 20 × log10(peak)    // -∞ to 0
    percent = clamp((dBFS + 60) / 60 × 100, 0, 100)
    Update meter bar width
    Peak hold: if new peak > held → update + reset 1500ms timer
               else after timer expires → decay at 0.0005/ms × 100%
    Color: red if > -3 dB, orange if > -10 dB
  ELSE IF was playing (one-shot reset):
    Reset meter, peak hold, dBFS display to zero
```

### 8. Speed-shifted WAV export

```
Same PCM data is written to the output file bit-for-bit.
Only the WAV header's sample rate field is changed:
  targetSampleRate = originalSampleRate × playbackRate
Any player reads the file at the declared rate → pitch/speed shift.
No resampling, no transcoding. Bit-perfect copy.
```

### 9. Wall-clock ↔ session-time conversion

```
toWallClock(sessionTime):
  file = find last file where sessionTime >= file.timeStart
  return file.wallClockStart + (sessionTime - file.timeStart)

fromWallClock(wallSeconds):
  Handle midnight crossing: if session starts after noon and target < noon,
    add 86400 to target
  Find file where target falls within [fileWallStart, fileWallStart + duration)
  return file.timeStart + (target - fileWallStart)
```

### 10. Live spectrogram rendering (spectrogram.js _renderLiveFrame)

```
Build/reuse 256-entry color LUT from current colormap preset
Build/reuse Y→bin mapping table (invalidated on frequency range/scale/size change)

FOR each pixel column x:
  colIdx = totalCols - w + x  (circular buffer index)
  mag = liveColCache[colIdx % w]   (cached FFT magnitude array)

  FOR each pixel row y:
    Interpolate between adjacent frequency bins using Y mapping
    db = raw + gainDB
    norm = clamp(round((db - floor) / dynamicRange × 255), 0, 255)
    pixel = colorLUT[norm × 4 .. norm × 4 + 3]   (direct array lookup, no function call)

ImageData buffer is reused across frames (allocated once per canvas size)
```

### 11. Live audio capture (live-capture.js)

```
getUserMedia(deviceId) → AudioContext → AudioWorklet (or ScriptProcessor fallback)

Ring buffer: Float32Array of bufferDuration × sampleRate samples
  Write pointer wraps around; totalSamplesWritten tracks absolute position
  readSample(index) reads from ring buffer at index % bufferSize

Recording (optional):
  Chunks pushed to array while isRecording=true
  On stop: concatenate chunks → WAV blob for export

Per audio block callback:
  Write samples to ring buffer
  Compute peak and RMS for VU metering
  Call onData/onLevelUpdate callbacks
```

## API endpoints and CLI commands

### HTTP audio server (localhost only)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `http://127.0.0.1:<port>/audio` | GET | Serves stitched virtual WAV (200 with full Content-Length) |
| `http://127.0.0.1:<port>/audio` | GET + `Range: bytes=N-M` | Partial content (206) for seeking |

The port is randomly assigned by the OS at startup. CORS header `Access-Control-Allow-Origin: *` is set on all responses.

### npm scripts (CLI)

| Command | Description |
|---------|-------------|
| `npm start` | Launch the app via `electron .` |
| `npm run pack` | Build unpacked distributable via `electron-builder --dir` |
| `npm run dist` | Build platform installer (macOS/Linux/Windows) |
| `npm run clean` | Remove `dist/` directory |

### OS file association

The app registers as a handler for `.wav` files. Files opened via OS double-click or command-line args are sent to the renderer via the `open-files` IPC channel (`ipcRenderer.on`).

```bash
# Open files directly from command line
electron . /path/to/recording.wav
electron . /path/to/file1.wav /path/to/file2.wav
```

## Edge cases, limitations, and critical implementation notes

### Edge cases explicitly handled

| Case | How handled |
|------|-------------|
| **Files >4 GB** | RIFF/data chunk sizes capped to `0xFFFFFFFF` in output headers. Data chunk size corrected from actual file size if declared as `0`, `0xFFFFFFFF`, or exceeding file size. Browser audio duration passed explicitly (`knownDuration`) because the `<audio>` element can't parse sizes beyond uint32. |
| **WAVE_FORMAT_EXTENSIBLE (0xFFFE)** | Real format (PCM/float) extracted from SubFormat GUID at fmt+24. **`bitsPerSample` is NOT overridden by `wValidBitsPerSample`** — container size must be preserved for correct `blockAlign`. Overriding causes byte misalignment and spectral artifacts (e.g. bright line at sampleRate/3). |
| **Midnight-crossing recordings** | When sorting BWF files by timecode, if two times differ by >12 hours, the earlier one is treated as next-day. Same logic applied in `fromWallClock()` conversion. |
| **Corrupt WAV headers** | RIFF size field ignored; parser scans entire 1 MB buffer. Chunk IDs validated as printable ASCII, sizes checked against `0xFFFFFFF0` sentinel. Parsing stops on first invalid chunk. |
| **High sample rates (96–384 kHz)** | Decimated to ≤48 kHz for browser playback (`decimationFactor = round(sourceRate / 48000)`). FFT size auto-bumped to 4096 when source rate >48 kHz. |
| **24-bit PCM** | Custom 3-byte decode: read b0/b1 as unsigned + b2 as signed, reconstruct 24-bit value, sign-extend, right-shift to 16-bit with clamping. |
| **32-bit float PCM** | Read as `Float32LE`, multiply by 32767, round, clamp to `[-32768, 32767]`. |
| **iXML chunk** | Capped at 8192 bytes to avoid parsing huge XML blobs. Used as timecode fallback only when bext is absent. |
| **Memory limit for spectrogram** | Full-mode reads capped at 16M samples (~64 MB). Beyond that, subsampled mode kicks in using scattered reads (~20 MB transfer instead of ~4 GB). |
| **Incompatible files in folder** | Files with mismatched sample rate, channels, or bit depth are silently skipped with a console warning. |

### Critical implementation notes

1. **`blockAlign = channels × (bitsPerSample / 8)`** — must use container `bitsPerSample`, never `validBitsPerSample`. Every byte offset in the app depends on this being correct.

2. **Uint64 timecode reference** — JavaScript lacks native uint64. Read as two uint32 values: `timeHigh * 0x100000000 + timeLow`. Do not use bitwise ops (limited to 32-bit).

3. **Audio output is always 16-bit PCM** regardless of source format. All conversion happens in the HTTP server's `convert16bit()`. The spectrogram reads raw source bytes directly (no conversion).

4. **`preservesPitch = false`** on the `<audio>` element — this is intentional tape-speed behavior. Slower playback = lower pitch. Required for the speed-shifted export feature to make sense.

5. **Spectrogram gain is applied at render time**, not during FFT. FFT magnitudes are stored in dB as computed. Gain and dynamic range are added during the pixel-mapping step, allowing instant re-render without recomputing FFT.

6. **File descriptor cache** (10s TTL) — avoids repeated `open()`/`close()` on the same file during rapid sequential reads. All cached FDs must be closed on session change and app quit.

7. **Tile cache key must include channel** — key format is `${startSample}-${endSample}-${fftSize}-${targetFrames}-ch${channel}`. Without the channel suffix, switching channels shows stale data.

8. **Speed-shifted export writes identical PCM bytes** — only the WAV header's sample rate field changes. No resampling, no transcoding. This is the entire implementation.

9. **`AudioContext` created with system default sample rate**, not the file's rate. Forcing the file's rate (e.g. 96 kHz) may fail on hardware that doesn't support it. The `<audio>` element + `MediaElementSource` handles resampling internally.

10. **Drag-and-drop requires `webUtils.getPathForFile()`** in Electron 33+. The old `File.path` property was removed. Falls back to `file.path` for older Electron versions.

### Known limitations

- No dithering on 24/32-bit → 16-bit downconversion (simple truncation/rounding).
- Anti-alias filter is a simple moving-average (boxcar) — adequate but not as sharp as a windowed-sinc FIR.
- Loop region enforcement checked per-frame in rAF; seeking near loop end may briefly play outside bounds.
- Single-threaded IPC for PCM reads — worker pool is for FFT only, not I/O.
- No RF64/BW64 support — files >4 GB work via size correction heuristics, not via the ds64 chunk.
- Annotation autoload only checks the recording folder, not subdirectories.
- Theme preference is the only setting persisted across sessions (via `localStorage`).
