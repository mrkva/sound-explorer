# Field Recording Explorer

A desktop application for reviewing, navigating, and annotating long-duration field recordings with a high-resolution spectrogram. Built for wildlife researchers, sound ecologists, and anyone who works with hours of unattended audio captured in the wild.

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

> **Warning: This application is vibe-coded.** It was developed with AI assistance and has not been rigorously tested across all edge cases. Use at your own risk. Always keep backups of your original recordings — the app never modifies source files.

## What this project does

Field Recording Explorer loads WAV files — single files or entire folders — and presents them as one continuous, scrollable, zoomable spectrogram. Files containing Broadcast Wave Format (BWF) metadata are automatically stitched together in chronological order with wall-clock time navigation. You can visually scan hours of audio for events of interest, select and loop time ranges, annotate them with notes, and export segments as new WAV files — including speed-shifted exports for ultrasonic content.

## Features

### Spectrogram
- On-demand FFT computed only for the visible time window, parallelized across CPU cores via Web Workers
- Subsampled mode for zoomed-out views of 30+ minute recordings (scattered reads transfer ~20 MB instead of ~4 GB)
- Tile cache for instant scrolling through previously viewed regions
- FFT sizes from 128 to 32768 bins; six colormaps (Viridis, Magma, Inferno, Grayscale, Green, Hot)
- Linear or logarithmic frequency scale with presets (Birds, Voice, Low, Mid, Full)
- Adjustable spectrogram gain (0–80 dB) and dynamic range (30–140 dB)
- Per-channel display or mono downmix; split-channel view for stereo files

### Audio
- Playback through Web Audio API with gain amplification up to +60 dB
- VU meter with dBFS scale (-60 to 0), peak hold indicator, and numeric readout
- "Play as" speed selector (0.125x–4x) with tape-speed pitch behavior for ultrasonic demodulation
- Audio output device selection
- High sample rate files (up to 384 kHz) decimated to 48 kHz for browser playback

### Navigation
- Pinch-to-zoom and horizontal two-finger scroll on trackpads
- Keyboard zoom (+/-), pan (scroll left/right), and seek (arrow keys)
- Right-click drag to pan the view
- Wall-clock or position-based time jump input
- Horizontal scrollbar for overview navigation
- Timecode offset correction (-12h to +12h)

### Selection and annotation
- Click-drag to select a time range; selection immediately starts looping
- Editable From/To time inputs with duration presets (5s to 5m)
- Zoom to selection (`S` key)
- Annotate selections with notes — displayed as color-coded overlays with stacked labels
- Annotations sidebar with Go To, Export WAV, and Delete per annotation
- Save annotations to JSON (+ companion `ffmpeg` shell script); load from JSON
- Auto-loads `*.annotations.json` files found in the recording folder

### Export
- Export selection or annotation as WAV — bit-perfect PCM copy at original format and sample rate
- Speed-shifted export: writes the same PCM data with a different sample rate in the WAV header, so any player reproduces it at the altered speed/pitch
- Batch export all annotations to a folder
- Exported files include BWF bext metadata (origination date/time, timecode reference)
- ISO 8601 filenames: `2026-03-01T12:30:00--2026-03-01T12:45:00_wolf howling.wav`

### Multi-file sessions
- Open a folder of WAV files from the same recording device
- Files sorted by BWF timecode and stitched into a single continuous timeline
- Wall-clock time display and navigation; midnight crossing handled correctly
- File boundaries marked on the spectrogram; click file info to see file list

### Theming
- Dark mode (default) and light mode, toggled via toolbar button
- Theme preference saved to localStorage
- LOM-inspired minimal aesthetic with CSS custom properties

## Supported formats

| Format | Bit depth | Sample rates | Notes |
|--------|-----------|-------------|-------|
| PCM WAV | 16-bit, 24-bit, 32-bit | Any (tested up to 384 kHz) | Standard integer PCM |
| IEEE Float WAV | 32-bit | Any | Floating-point samples |
| WAVE_FORMAT_EXTENSIBLE | All above | Any | Handles container/valid bit mismatch |
| BWF (Broadcast Wave) | All above | Any | Reads `bext` chunk for timecode and origination metadata |
| iXML | — | — | Extracts timecode from embedded iXML metadata |

Multi-channel files are downmixed to mono for spectrogram computation. Playback preserves all channels.

## Requirements / prerequisites

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- No runtime dependencies — only `electron` and `electron-builder` as devDependencies

## Installation

```bash
git clone https://github.com/mrkva/field-recording-explorer.git
cd field-recording-explorer
npm install
npm start
```

### Building distributable packages

```bash
npm run dist          # Build for current platform (cleans dist/ first)
npm run pack          # Build unpacked (for testing)
npm run clean         # Remove dist/ folder
```

Platform-specific builds:

```bash
npx electron-builder --mac     # .dmg
npx electron-builder --win     # .exe (NSIS) + portable
npx electron-builder --linux   # .AppImage + .deb
```

Output goes to the `dist/` folder.

## Configuration

All settings are in the bottom bar of the UI and take effect immediately:

| Section | Controls |
|---------|----------|
| **Audio** | Gain (0–60 dB), Volume (0–100%), VU meter, Output device |
| **Spectrogram** | Gain (0–80 dB), Dynamic range (30–140 dB), FFT size (128–32768), Colormap, Channel |
| **Frequency** | Min/Max Hz, Preset (Full/Birds/Voice/Low/Mid), Log scale toggle |

Additional controls in the toolbar and info strip:
- **Play as** — Playback speed / sample rate reinterpretation (0.125x–4x)
- **TC offset** — Timecode offset correction (-12h to +12h)
- **Theme toggle** — Dark/light mode (saved to localStorage)

## Usage

### Opening recordings

- **Open Folder** — Select a folder of WAV files. Files are sorted by BWF timecode and stitched into a continuous timeline.
- **Open File(s)** — Select one or more WAV files.
- **Drag and drop** — Drop WAV files or a folder onto the window.

### Navigating

| Action | How |
|--------|-----|
| Zoom in/out | Pinch (trackpad), Ctrl+scroll, `+`/`-` keys, or toolbar buttons |
| Pan in time | Two-finger horizontal scroll, or right-click drag |
| Seek | Click on the spectrogram |
| Jump to time | Type a time (e.g. `22:35`) in the time input and press Enter |
| Fit entire recording | `F` key or Fit button |

### Selecting and exporting

1. **Select** — Click and drag on the spectrogram. The selection loops automatically.
2. **Annotate** — Click Annotate, type a note, and save.
3. **Export WAV** — Exports the selection at the original sample rate and bit depth.
4. **Export Slowed** — Appears when playback speed is not 1x. Exports the same PCM data with the modified sample rate baked into the WAV header.

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `Left` / `Right` | Seek ±1 second |
| `Shift+Left` / `Shift+Right` | Seek ±10 seconds |
| `Home` / `End` | Jump to start / end |
| `+` / `-` | Zoom in / out |
| `F` | Fit entire recording in view |
| `S` | Zoom to selection |
| `G` | Focus the time input field |
| `Up` / `Down` | Adjust spectrogram gain ±5 dB |
| `Esc` | Clear selection |

Trackpad and mouse:

| Gesture | Action |
|---------|--------|
| Pinch / Ctrl+scroll | Zoom at cursor |
| Scroll left/right | Pan in time |
| Left-drag | Select time range |
| Right-drag | Pan view |
| Drag & drop | Open WAV files |

### Managing annotations

- **Annotations panel** — Click the Annotations button to open the sidebar.
- **Go to** — Jump the view to any annotation.
- **Export WAV** — Export a single annotation.
- **Export All** — Batch-export every annotation to a folder.
- **Save** — Export annotations to JSON (+ companion `ffmpeg` shell script).
- **Load** — Import previously saved annotations from JSON.
- **Auto-load** — On session load, the app checks the recording folder for `<filename>.annotations.json` or `annotations.json` and loads them automatically.

## Project structure

```
field-recording-explorer/
├── main.js              Electron main process: IPC handlers, HTTP audio server, WAV export
├── preload.js           Context bridge: exposes IPC methods to renderer
├── index.html           Application layout: toolbar, info strip, canvas, bottom bar, modals
├── package.json         App metadata, build config, scripts
├── src/
│   ├── app.js           App controller: UI wiring, annotations, keyboard, VU meter, themes
│   ├── session.js       Multi-file session manager: timeline stitching, wall-clock mapping
│   ├── spectrogram.js   Spectrogram renderer: on-demand FFT, worker pool, tile cache, canvas
│   ├── audio-engine.js  Audio playback: Web Audio API, gain, looping, level metering
│   ├── bwf-parser.js    WAV/BWF header parser: fmt, bext, iXML chunk extraction
│   ├── fft-worker.js    Web Worker: parallel FFT computation (Cooley-Tukey radix-2)
│   └── render-worker.js Web Worker: spectrogram pixel rendering with colormap LUTs
├── styles/
│   └── main.css         Dark/light theme via CSS custom properties
└── docs/
    └── ARCHITECTURE.md  Detailed architecture: module APIs, IPC channels, data flow diagrams
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed module documentation, all IPC channels, and data flow diagrams.

## License

MIT
