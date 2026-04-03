# Field Recording Explorer

A desktop application for reviewing, navigating, and annotating long-duration field recordings with a high-resolution spectrogram. Built for wildlife researchers, sound ecologists, and anyone who works with hours of unattended audio captured in the wild.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

> **Warning: This application is vibe-coded.** It was developed with AI assistance and has not been rigorously tested across all edge cases. Use at your own risk. Do not rely on it for critical work without verifying results independently. Always keep backups of your original recordings — the app never modifies source files, but exported WAV segments should be spot-checked.

## What it does

Field Recording Explorer loads WAV files — single files or entire folders of them — and presents them as one continuous, scrollable, zoomable spectrogram. If the files contain Broadcast Wave Format (BWF) metadata with embedded timecodes, they are automatically stitched together in chronological order, with wall-clock time displayed alongside the recording timeline.

You can visually scan hours of audio for events of interest (bird calls, animal vocalizations, weather, human activity), select time ranges, loop them for focused listening, annotate them with notes, and export annotated segments directly as new WAV files — all without leaving the application.

### Key capabilities

- **Multi-file session stitching** — Open a folder of WAV files recorded by the same device. Files are sorted by BWF timecode and presented as a single continuous timeline. Gaps between files are preserved accurately.
- **High-resolution spectrogram** — Computes FFT on-demand for the visible time window only, using a pool of Web Workers for parallel computation across CPU cores. Cached tiles allow instant scrolling through previously viewed regions.
- **Wall-clock time navigation** — If files contain BWF `bext` chunk metadata (origination date/time or timecode reference), the interface shows real wall-clock times. Type a time like `22:35` to jump directly to that moment in the recording.
- **Flexible frequency display** — Adjustable frequency range with presets (Birds 100-10kHz, Voice 80-4kHz, Low 20-500Hz, Mid 200-8kHz, Full), logarithmic frequency scale option, and configurable FFT size from 512 to 32768 bins.
- **Audio gain amplification** — Separate audio gain (amplifies playback through Web Audio API) and spectrogram gain (visual boost) controls. Hear faint sounds like distant wolf howls by boosting audio gain up to +60 dB without affecting the source file.
- **Time range selection and looping** — Click and drag on the spectrogram to select a time range. The selection immediately begins looping for focused listening. Adjust the selection, annotate it, or export it as a WAV file.
- **Annotation system** — Save notes about interesting segments with precise file references, wall-clock timestamps, and session positions. Annotations appear as color-coded overlays on the spectrogram with stacked labels for overlapping regions.
- **Direct WAV export** — Export any selection or annotation as a standalone WAV file in the original format (no transcoding, no quality loss). Filenames use ISO 8601 date-time ranges for easy sorting: `2026-03-01T12:30:00--2026-03-01T12:45:00_wolf howling.wav`.
- **Batch export** — Export all annotations at once to a chosen folder.
- **Annotation persistence** — Save annotations to JSON and reload them later. A companion shell script using `ffmpeg` is also generated alongside the JSON for command-line batch processing.

## Supported formats

| Format | Bit depth | Sample rates | Notes |
|--------|-----------|-------------|-------|
| PCM WAV | 16-bit, 24-bit, 32-bit | Any (tested up to 384 kHz) | Standard integer PCM |
| IEEE Float WAV | 32-bit | Any | Floating-point samples |
| WAVE_FORMAT_EXTENSIBLE | All above | Any | Handles container/valid bit mismatch (e.g., 24-bit in 32-bit container) |
| BWF (Broadcast Wave) | All above | Any | Reads `bext` chunk for timecode and origination metadata |
| iXML | — | — | Extracts timecode from embedded iXML metadata |

Multi-channel files are downmixed to mono for spectrogram computation. Playback preserves all channels.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- npm (comes with Node.js)

### Setup

```bash
git clone https://github.com/mrkva/field-recording-explorer.git
cd field-recording-explorer
npm install
npm start
```

### Building distributable packages

```bash
# macOS
npm run dist

# Or platform-specific
npx electron-builder --mac
npx electron-builder --win
npx electron-builder --linux
```

Produces `.dmg` (macOS), `.exe`/portable (Windows), or `.AppImage`/`.deb` (Linux) in the `dist/` folder.

## Usage

### Opening recordings

- **Open Folder** — Select a folder containing WAV files from the same recording session. Files are sorted by BWF timecode and stitched into a continuous timeline.
- **Open File(s)** — Select one or more individual WAV files. Multiple files are stitched the same way as a folder.

### Navigating the spectrogram

| Action | How |
|--------|-----|
| **Zoom in/out** | Scroll wheel, `+`/`-` keys, or toolbar buttons |
| **Pan** | Right-click and drag |
| **Seek** | Click on the spectrogram |
| **Jump to time** | Type a wall-clock time (e.g., `22:35`) in the time input and press Enter or click Go |
| **Fit entire recording** | `F` key or Fit All button |
| **Adjust spectrogram brightness** | Arrow keys `Up`/`Down` |

### Selecting and annotating

1. **Select a range** — Click and drag on the spectrogram. The selection starts looping immediately.
2. **Listen** — The selected range plays in a loop. Adjust selection by making a new one.
3. **Annotate** — Click the Annotate button in the toolbar. Enter a descriptive note (e.g., "wolf howling") and save. Click Annotate again to dismiss the dialog.
4. **Export** — Click Export WAV to save the selected segment as a standalone file.

Annotations appear as color-coded overlays on the spectrogram. Each annotation gets a distinct color, and overlapping annotations stack their labels vertically so everything remains readable.

### Managing annotations

- **Annotations panel** — Click the Annotations button to open the list of all annotations.
- **Go to** — Jump the view to any annotation.
- **Export WAV** — Export a single annotation as a WAV file.
- **Export All** — Batch-export every annotation to a folder.
- **Save** — Export annotations to a JSON file (plus a companion `ffmpeg` shell script).
- **Load** — Import previously saved annotations from a JSON file.
- **Delete** — Two-click confirmation to prevent accidental deletion.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Left` / `Right` | Seek ±1 second |
| `Shift+Left` / `Shift+Right` | Seek ±10 seconds |
| `Home` / `End` | Jump to start / end |
| `+` / `-` | Zoom in / out |
| `F` | Fit entire recording in view |
| `G` | Focus the time input field |
| `Up` / `Down` | Adjust spectrogram gain ±5 dB |
| `Scroll wheel` | Zoom at cursor position |
| `Escape` | Clear selection |

### Spectrogram settings

All settings are in the bottom bar:

- **Audio Gain** — Amplifies playback volume (0 to +60 dB). Does not affect the source file.
- **Volume** — Standard volume control (0–100%).
- **VU Meter** — Real-time peak level indicator.
- **Spectrogram Gain** — Visual brightness boost (0 to +80 dB). Changes are instant, no recomputation.
- **Dynamic Range** — Controls the contrast range (30–140 dB). Lower values increase contrast.
- **FFT Size** — Frequency resolution (512–32768). Larger = finer frequency detail but coarser time detail. Auto-increased to 4096 for sample rates above 48 kHz.
- **Min/Max Frequency** — Restrict the displayed frequency range.
- **Frequency Presets** — Quick presets for common use cases (Birds, Voice, Low, Mid, Full).
- **Log Frequency** — Toggle logarithmic frequency scale (useful for music and voice).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Electron Main Process                        │
│                             (main.js)                               │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  WAV/BWF Parser   │  │ Local HTTP Server │  │   WAV Exporter   │  │
│  │  (header reading)  │  │ (audio streaming) │  │ (segment export) │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│           │                     │                      │            │
│           └─────────────────────┼──────────────────────┘            │
│                                 │  IPC                              │
├─────────────────────────────────┼───────────────────────────────────┤
│                        preload.js (bridge)                          │
├─────────────────────────────────┼───────────────────────────────────┤
│                        Renderer Process                             │
│                                                                     │
│  ┌──────────────┐  ┌───────────────────┐  ┌────────────────────┐   │
│  │   Session     │  │    Spectrogram    │  │   Audio Engine     │   │
│  │  (session.js) │  │ (spectrogram.js)  │  │ (audio-engine.js)  │   │
│  │              │  │                   │  │                    │   │
│  │ File sorting  │  │ On-demand FFT     │  │ <audio> element    │   │
│  │ Timeline      │  │ Worker pool       │  │ Web Audio API      │   │
│  │ Wall clock    │  │ Tile cache        │  │ GainNode           │   │
│  │ mapping       │  │ Canvas 2D render  │  │ AnalyserNode       │   │
│  └──────────────┘  └───────┬───────────┘  └────────────────────┘   │
│                            │                                        │
│                    ┌───────┴───────┐                                │
│                    │  FFT Workers   │                                │
│                    │ (fft-worker.js)│                                │
│                    │  ×N cores      │                                │
│                    └───────────────┘                                │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    App Controller (app.js)                    │   │
│  │  UI wiring, annotations, export, selection, keyboard, VU     │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                  BWF Parser (bwf-parser.js)                   │   │
│  │  RIFF/WAVE chunk parsing, bext, iXML, timecode extraction     │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### How the spectrogram works

1. **On-demand computation** — Only the visible time window is computed. Zooming out over hours of audio uses subsampled FFT (evenly spaced windows) for speed; zooming in computes continuous overlapping frames.

2. **Web Worker pool** — FFT frames are distributed across `N` workers (one per CPU core, up to 8). Each worker receives batches of windowed audio frames and returns magnitude spectra in dB.

3. **FFT implementation** — Cooley-Tukey radix-2 with Hann windowing. Bit-reversal permutation, butterfly stages, magnitudes computed as `20 * log10(|FFT|)`.

4. **Tile cache** — Computed spectrogram tiles are cached by view range and FFT size. Scrolling back to a previously viewed region is instant.

5. **Two-pass rendering** — The FFT data is rendered to an ImageData buffer (frequency-to-pixel mapping with linear interpolation between bins). Gain and dynamic range adjustments re-render from cached FFT data without recomputation.

6. **Color presets** — Six colormaps: Viridis (perceptually uniform, default), Magma, Inferno, Grayscale, Green, and Hot. All use multi-stop interpolation for smooth gradients.

### How audio playback works

The main process runs a local HTTP server that presents all session files as a single virtual WAV file. The server:

- Builds a standard 16-bit PCM WAV header with the correct total size
- Converts source audio (16/24/32-bit int or 32-bit float) to 16-bit on the fly
- Supports HTTP Range requests for seeking
- Streams data in chunks to handle multi-gigabyte sessions

The renderer connects an `<audio>` element to this server URL, then routes it through Web Audio API: `MediaElementSource → GainNode → AnalyserNode → destination`. The GainNode provides amplification; the AnalyserNode feeds the VU meter.

For high sample rate files (e.g., 192 kHz ultrasonic recordings), server-side decimation reduces the sample rate to a browser-compatible rate (max 48 kHz). The "Play as" selector in the toolbar lets you choose the output rate — useful for demodulating ultrasonic bat calls by listening at a lower rate.

**Playback quality note:** Audio is always converted to 16-bit PCM for browser playback. This is a limitation of the HTML5 `<audio>` element. The info strip shows the actual playback format (sample rate, bit depth). This application is designed for review, navigation, and annotation — not for critical or audiophile listening. Use a dedicated audio editor for high-fidelity playback.

### How BWF timecode works

Broadcast Wave Format files embed recording metadata in a `bext` chunk:

- **Origination Date** — `YYYY-MM-DD` when the recording started
- **Origination Time** — `HH:MM:SS` wall-clock time
- **Timecode Reference** — Sample-accurate start time (sample count since midnight)

When files from the same session are loaded, they are sorted by timecode and stitched into a continuous timeline. The interface translates between session position (seconds from start) and wall-clock time in both directions, handling midnight crossings correctly.

## File structure

```
field-recording-explorer/
├── main.js              # Electron main process: IPC, audio server, WAV parser, file I/O
├── preload.js           # Context bridge: exposes IPC methods to renderer
├── index.html           # Application layout: toolbar, info strip, canvas, bottom bar
├── package.json         # Dependencies and build configuration
├── src/
│   ├── app.js           # Main app controller: UI wiring, annotations, export
│   ├── session.js       # Multi-file session manager: timeline, wall-clock mapping
│   ├── spectrogram.js   # Spectrogram renderer: FFT, workers, canvas, interaction
│   ├── audio-engine.js  # Audio playback: Web Audio API, gain, looping, VU
│   ├── bwf-parser.js    # BWF/WAV header parser: fmt, bext, iXML chunks
│   └── fft-worker.js    # Web Worker: parallel FFT computation
└── styles/
    └── main.css         # Dark theme UI styles
```

## License

MIT
