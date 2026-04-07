# Sound Explorer

A monorepo containing two spectrogram viewer / audio player applications for ultrasonic field recordings, built by [LOM](https://lom.audio).

Both apps were vibecoded with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic's AI coding agent). No frameworks, no bundlers, no npm (except Electron), no TypeScript, no build step. Just plain ES modules.

## Repository structure

```
sound-explorer/
  lib/             ← shared: FFT engine, colormaps
    fft-core.js        Cooley-Tukey radix-2 FFT, twiddle/bit-reversal caches, Hann window, dB magnitudes
    colormaps.js       Viridis, Magma, Inferno, Grayscale, Green, Hot presets + 256-entry RGBA LUT builder
  apps/
    desktop/       ← Electron desktop app
    web/           ← browser lite version (GitHub Pages)
```

## Apps

### Desktop — Field Recording Explorer

A desktop Electron application for reviewing, navigating, and annotating long-duration field recordings with a high-resolution zoomable spectrogram.

**Key features:**
- Multi-file sessions: load a folder of WAV files stitched into one continuous timeline via BWF timecode
- On-demand FFT parallelized across CPU cores, with subsampled mode for zoomed-out overview of 30+ minute recordings
- Tile-cached spectrogram with six colormaps, log/linear frequency scale, adjustable gain and dynamic range
- Tape-speed playback (0.125x--4x) for ultrasonic demodulation, with audio output device selection
- Annotation system with color-coded overlays, batch WAV export, and JSON save/load
- BWF/iXML metadata read/write, Field Recording Metadata (FRM) sidecar support
- Split-channel view, VU meter, wall-clock time navigation

**Running:**
```bash
cd apps/desktop
npm install
npm start
```

See [apps/desktop/README.md](apps/desktop/README.md) for full documentation.

### Web — Sound Explorer

A browser-only spectrogram viewer and audio player. Runs entirely in the browser with no server backend. Deployed to GitHub Pages.

**Try it live: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

**Key features:**
- Drag-and-drop WAV files, works offline as a PWA
- Spectrogram with FFT computed in parallel Web Workers, tile cache for instant scrolling
- True tape-speed playback via WAV header sample rate manipulation (no `playbackRate` glitches)
- Supports PCM 16/24/32-bit int and 32-bit float at any sample rate (tested up to 384kHz)
- BWF timecode parsing, annotations, region selection and WAV export
- Per-channel VU meters, multichannel support

**Running locally:**
```bash
cd apps/web
python3 -m http.server 8765
```

Then open `http://localhost:8765` in your browser. See [apps/web/README.md](apps/web/README.md) for details.

## Shared library (`lib/`)

Both apps import shared modules from `lib/` via ES module workers:

| Module | What it provides |
|--------|-----------------|
| `lib/fft-core.js` | Cooley-Tukey radix-2 FFT with pre-computed twiddle factors and bit-reversal tables, Hann window cache, dB magnitude extraction |
| `lib/colormaps.js` | Six colormap presets (viridis, magma, inferno, grayscale, green, hot) and a 256-entry RGBA lookup table builder |

Workers in both apps are loaded as ES module workers (`new Worker(path, {type: 'module'})`) so they can import directly from `lib/`.

## Supported formats

| Format | Bit depth | Sample rates |
|--------|-----------|-------------|
| PCM WAV | 16-bit, 24-bit, 32-bit | Any (tested up to 384 kHz) |
| IEEE Float WAV | 32-bit | Any |
| WAVE_FORMAT_EXTENSIBLE | All above | Any |
| BWF (Broadcast Wave) | All above | Any |

## License

MIT
