# Field Recording Explorer — Web Edition

Build a **client-side web application that runs entirely in the browser**. The output is a set of static files (HTML + CSS + JS) served by a plain nginx web server — no Node.js, no backend, no server-side processing whatsoever. Users open the app by navigating to a URL in Chrome, Firefox, or Edge. All WAV file parsing, spectrogram computation, audio playback, and WAV export happen client-side using browser APIs (File API, Web Audio API, Canvas, Web Workers, Blob URLs).

The target users are biology students who record bats and wildlife with ultrasonic recorders (sample rates 192kHz, 256kHz, 384kHz). They need to slow down playback to hear ultrasonic content, view spectrograms, zoom into time/frequency regions, and export annotated segments as WAV files.

## Architecture

```
index.html          — Single-page app shell
css/main.css        — Dark theme styling
js/app.js           — Main application controller
js/spectrogram.js   — Spectrogram renderer (canvas-based)
js/audio-engine.js  — Playback engine (Web Audio API)
js/wav-parser.js    — WAV/BWF file parser (reads fmt, data, bext chunks)
js/fft-worker.js    — Web Worker for parallel FFT computation
js/render-worker.js — Web Worker for spectrogram pixel rendering
```

No bundler, no npm, no TypeScript, no Node.js. Plain ES modules (`<script type="module">`). The entire app is static files served by nginx — a user visits the URL in their browser and everything runs client-side. Must work in modern Chrome/Firefox/Edge.

## Core Features (in priority order)

### 1. File Loading
- Drag-and-drop WAV files onto the page, or use `<input type="file" multiple accept=".wav">` button
- Parse WAV headers client-side using the File API (`file.slice()` + `FileReader` or `file.arrayBuffer()`)
- Support: PCM 16/24/32-bit integer and 32-bit IEEE float, mono and multichannel, any sample rate
- Parse BWF `bext` chunk for timecode (originationDate, originationTime, timeReference as samples-since-midnight)
- Parse RIFF chunks by walking from offset 12: read 4-byte ASCII chunk ID + 4-byte LE uint32 size. Validate chunk IDs are printable ASCII and sizes are < 0xFFFFFFF0 to handle corrupted headers
- For `fmt ` chunk: handle WAVE_FORMAT_EXTENSIBLE (format code 0xFFFE) by reading the SubFormat GUID at offset 24 within the chunk — first two bytes give the actual format (1=PCM, 3=float)
- Store file references as `File` objects (don't read entire files into memory!)
- For multiple files: sort by BWF start-time-of-day, build a unified timeline

### 2. Spectrogram Rendering
- Full-width `<canvas>` element with 50px left margin (frequency axis) and 40px bottom margin (time axis)
- **On-demand computation**: only compute FFT for the visible time range
- **Read PCM data in chunks** using `file.slice(byteOffset, byteOffset + length).arrayBuffer()` — never load the entire file
- **PCM decoding** from raw bytes to Float32Array mono samples:
  - 16-bit: `dataView.getInt16(offset, true) / 32768`
  - 24-bit: `(signedByte2 * 65536 + byte1 * 256 + byte0) / 8388608` where byte2 is read with `getInt8` (signed)
  - 32-bit int: `dataView.getInt32(offset, true) / 2147483648`
  - 32-bit float: `dataView.getFloat32(offset, true)`
  - For multichannel: average all channels for mono downmix, or extract a specific channel
- **FFT via Web Workers**: create a pool of `Math.min(navigator.hardwareConcurrency || 4, 8)` workers
  - Use Cooley-Tukey radix-2 FFT
  - **Critical optimization**: pre-compute twiddle factor lookup tables (`cos`/`sin` arrays of size N/2, keyed by FFT size) and bit-reversal permutation tables. Cache these per FFT size. This gives a major speedup
  - Each worker receives a contiguous PCM Float32Array slice + Hann window + hop info, processes multiple frames, returns dB magnitude arrays
  - Transfer ArrayBuffers back (transferable objects) for zero-copy
- **Hop size**: driven by pixel density: `Math.max(64, Math.floor(viewDurationSamples / targetFrames))` where targetFrames = `Math.min(canvasWidth * 2, 4000)`. Do NOT enforce a minimum of fftSize/4 — this causes pixelation with large FFT windows
- **For wide views** (total samples > 16M): use subsampled mode — don't read all samples, instead read chunks and pick evenly-spaced windows
- **Rendering**: use a dedicated render worker that receives FFT magnitude frames and returns an ImageBitmap
  - Build a 256-entry color lookup table (LUT) from the colormap stops — avoids per-pixel interpolation
  - Support colormaps: viridis, magma, inferno, grayscale, green, hot
  - Frequency bin mapping: pre-compute Y→bin lookup tables supporting both linear and logarithmic frequency scales, with linear interpolation between adjacent bins
- **Tile caching**: cache computed spectrogram tiles keyed by `"startSample-endSample-fftSize-targetFrames-channel"` (Map, max ~200 entries)
- **FFT sizes**: offer 128, 256, 512, 1024, 2048 (default), 4096, 8192, 16384, 32768

### 3. Spectrogram Interaction
- **Scroll wheel**: zoom in/out centered on the playback cursor position (fall back to mouse position if no cursor). Debounce recompute by 150ms during continuous scrolling
- **Left-click + drag**: select a time range (highlight with semi-transparent blue overlay)
- **Right-click + drag**: pan the view. Prevent context menu on canvas
- **Click without drag**: seek playback to that time position
- **Zoom buttons** (+Zoom, -Zoom, Fit): zoom centered on the current playback cursor position
- **Playback cursor**: draw a vertical line at the current playback position in a contrasting color per colormap (e.g., red for viridis, cyan for hot). Store `_lastPlaybackTime` so the cursor persists across redraws that don't pass a time
- **Auto-follow**: when playing, if cursor reaches 90% of the view width, scroll the view forward (new view starts at cursor - 10% of view duration)
- **Selection**: when a selection is made, show From/To time inputs and a duration preset dropdown (5s/10s/15s/30s/45s/60s/2m/5m). Allow entering precise times in flexible format (H:MM:SS.cc, M:SS, or plain seconds)
- **Window resize**: debounce 200ms, then clear tile cache and recompute spectrogram at new canvas dimensions. Immediately stretch the old image while waiting

### 4. Audio Playback — Tape-Speed Mode
This is the **most critical feature** for the use case. Ultrasonic recordings (e.g., 384kHz bat calls) must be slowed down to be audible.

- Use an `<audio>` element with `preservesPitch = false` — this is essential. When playbackRate < 1, audio plays slower AND at lower pitch (like slowing down a tape). This is how students hear ultrasonic content
- Create a Blob URL from the WAV file for the audio source. For high sample rate files (>48kHz), you MUST decimate to ≤48kHz for the browser audio decoder:
  - Read the file, write a new WAV header with the output sample rate, and copy every Nth sample (where N = decimation factor)
  - Convert to 16-bit PCM regardless of source format
  - Build the output as a Blob, create URL with `URL.createObjectURL(blob)`
- **"Play as" speed selector**: show speed options like 0.125x, 0.25x, 0.5x, 1x (native), 2x, 4x. Display the interpreted sample rate (e.g., "48kHz (0.5x)" for a 96kHz file at half speed). Set `audioElement.playbackRate` directly
- **Gain control**: use a Web Audio GainNode. Convert dB to linear: `Math.pow(10, db / 20)`. Range: 0-60 dB boost
- **Volume**: `audioElement.volume` (0-1)
- **Loop playback**: when a selection exists, loop between selection start and end. Use `requestAnimationFrame` to check position and reset to loop start when past loop end
- **VU meter**: use an AnalyserNode (fftSize=256), compute peak and RMS from time-domain data

### 5. WAV Export (Client-Side)
- When the user selects a region and clicks "Export WAV", build a WAV file entirely in the browser:
  - Read the raw PCM bytes from the source file(s) using `file.slice()`
  - Write a proper RIFF/WAVE header: `fmt ` chunk (preserve original format) + `data` chunk
  - If BWF timecode is available, write a `bext` chunk between `fmt` and `data`:
    - 602 bytes: description (256), originator (32), originatorReference (32), originationDate (10, "YYYY-MM-DD"), originationTime (8, "HH:MM:SS"), timeReference (uint64 LE, samples since midnight), version (uint16, 0), UMID+reserved (254, zeroed)
    - **Important**: timeReference can exceed 2^32 for high sample rates. Split to two uint32 using modulo/division, NOT bitwise ops (JS bitwise converts to signed int32, causing RangeError)
  - Trigger download with `<a href="blob:..." download="filename.wav">`
  - Filename format: `YYYY-MM-DDTHH:MM:SS--YYYY-MM-DDTHH:MM:SS_note.wav` when timecode available

### 6. Channel Selection
- For multichannel files, show a "Ch" dropdown with: Mix (mono downmix), individual channels (1 (L), 2 (R), 3 (C), etc.), and split view pairs (L | R)
- Split view: divide the canvas vertically, render one channel's spectrogram in each half with a 2px grey divider and channel labels
- Hide the selector for mono files

### 7. Annotations
- Allow labeling selected time regions with a text note
- Store annotations in memory as `[{sessionStart, sessionEnd, note, wallClockStartISO, wallClockEndISO}]`
- Export annotations list as JSON
- Import annotations from JSON
- Draw annotation regions on the spectrogram as subtle colored overlays with labels

## UI Design

Dark theme matching the desktop version:
```css
--bg-primary: #0f0f1a;
--bg-secondary: #1a1a2e;
--bg-tertiary: #252540;
--text-primary: #e0e0f0;
--text-secondary: #8888aa;
--accent: #4fc3f7;
--border: #333355;
```

Layout (top to bottom):
1. **Toolbar**: Open Files button, Play/Stop, "Play as" speed selector, +Zoom/-Zoom/Fit, Go To (with wall clock / position mode toggle), selection controls, Annotations button, "?" shortcuts button
2. **Info strip**: POS (current time), WALL (wall clock if BWF), DUR (total duration), CUR (cursor freq + time), file info. Use fixed-width monospace spans to prevent layout jumps
3. **Canvas**: fills remaining vertical space
4. **Bottom bar**: Audio controls (gain, volume, output), Spectrogram controls (gain, range, FFT size, colors, channel selector), Frequency controls (min, max, preset, log checkbox)
5. **Status bar**: single line status messages

All control bars should use `flex-wrap: wrap` so they adapt to narrow windows without overflowing.

## Keyboard Shortcuts
- Space: Play/Pause
- Left/Right: Seek ±1s (±10s with Shift)
- Up/Down: Spectrogram gain ±5 dB
- +/-: Zoom in/out
- F: Fit entire file
- G: Focus Go To input
- Home/End: Jump to start/end
- Esc: Clear selection

Add a "?" button that opens a modal listing all shortcuts.

## Important Technical Notes

1. **Byte alignment**: when reading PCM chunks, ensure chunk sizes are multiples of `blockAlign` (channels × bytesPerSample). Misaligned reads cause noise bursts
2. **Large file handling**: never call `file.arrayBuffer()` on the whole file. Always use `file.slice(start, end)` to read chunks (max 8MB per read)
3. **dataSize correction**: WAV headers sometimes have wrong data sizes (0, 0xFFFFFFFF, or larger than file). Correct using: `dataSize = Math.min(headerDataSize, fileSize - dataOffset)`. If 0 or sentinel: `dataSize = fileSize - dataOffset`
4. **Floating point time display**: when formatting time as `M:SS.cc`, round to nearest centisecond FIRST (`Math.round(seconds * 100)`), then derive h/m/s/cs from that integer. Otherwise floating point truncation shows 30.0s as "0:29.99"
5. **Web Workers**: load workers from the same origin. Use `new Worker('js/fft-worker.js')`. Workers cannot import ES modules in all browsers yet — use self-contained scripts with `self.onmessage`
6. **Memory**: for files with total samples > 16 million in the visible view, force subsampled spectrogram mode to avoid allocating huge Float32Arrays
7. **Decimation for playback**: browsers typically can't decode WAV files with sample rates above 48kHz via `<audio>`. You must decimate to ≤48kHz. Simple approach: take every Nth sample. This can be done progressively (don't need entire file in memory — process in chunks, writing to a growing array of Buffers, then create Blob)

## What NOT to include (compared to the desktop version)
- No folder scanning (web can't access filesystem — use file picker only)
- No file associations or CLI arguments
- No audio output device selection (browser handles this)
- No persistent state between sessions (optional: use localStorage for preferences)
- No timecode offset adjustment (keep it simple for students)
- No multi-day date picker

## Verification
1. Open index.html in browser (via nginx or `python -m http.server`)
2. Drag a WAV file onto the page — should show spectrogram
3. Click Play — should hear audio
4. Change "Play as" to 0.25x on a 192kHz file — should hear slowed-down, lower-pitched audio
5. Scroll wheel to zoom in — spectrogram should recompute at higher resolution
6. Select a region, click Export — should download a valid WAV file that opens in other audio software
7. Test with: 16-bit/44.1kHz, 24-bit/96kHz, 32-bit-float/384kHz files
