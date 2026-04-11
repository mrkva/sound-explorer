# Sound Explorer

A spectrogram viewer and audio player for exploring field recordings, built by [LOM](https://lom.audio). Load a WAV file, see its spectrogram, zoom into time-frequency regions of interest, and play them back at different speeds -- slowing down a 384 kHz bat call or speeding through hours of dawn chorus.

**Try it now: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

Sound Explorer comes in two versions:

- **Web** -- runs in the browser, no install needed. Drag and drop WAV files, works offline as a PWA. Best for quick exploration of individual files and live audio input.
- **Desktop** (Electron) -- handles large files and multi-file sessions. Load an entire night of recordings as one continuous zoomable spectrogram with wall-clock time navigation.

Both versions share the same core: FFT computed in parallel Web Workers, tile-cached spectrogram rendering, tape-speed playback, and colormap-based visualization.

## Features

- **Spectrogram** -- parallel FFT across all CPU cores, tile cache for instant scrolling, six colormaps (viridis, magma, inferno, grayscale, green, hot), linear/logarithmic frequency scale, adjustable gain and dynamic range, FFT sizes from 128 to 32768
- **FFT window functions** -- Hann (default), Hamming, Blackman-Harris, and Flat-top windows for controlling spectral leakage vs. frequency resolution tradeoff
- **Tape-speed playback** -- change playback speed (0.0625x--4x) with proportional pitch shift, like speeding up or slowing down a tape. Useful for making ultrasonic content audible or skimming through long recordings
- **Live audio input** -- capture audio from a microphone or sound card and view the spectrogram in real time. Select input device, adjust time window (2--30s), record and export as WAV. Available in both web and desktop versions
- **Time-frequency navigation** -- scroll to zoom, drag to pan, click to seek, frequency range presets (Full, Birds, Voice, Low, Mid), overview minimap for quick navigation
- **Selection and export** -- select a region, loop it, export as WAV. Preserves BWF timecode. Can export at altered speed. Trim view to selection
- **Annotations** -- label time regions with notes, displayed as overlays on the spectrogram, export/import as JSON
- **Multichannel** -- mono downmix, per-channel view, split L|R display
- **VU meter** -- per-channel level metering with peak hold, dBFS scale, ballistic smoothing
- **BWF/timecode** -- parses Broadcast Wave Format metadata for wall-clock timestamps
- **Session metadata** -- comprehensive metadata forms (location, equipment, conditions, notes) with iXML and FRM sidecar support
- **Theming** -- dark and light modes, saved to localStorage

### Desktop-only features

- Multi-file sessions: load a folder of WAVs stitched into one timeline via BWF timecode
- Subsampled overview mode for 30+ minute recordings
- iXML metadata read/write, Field Recording Metadata (FRM) sidecar support
- Audio output device selection
- Batch annotation export
- Timecode offset correction (-12h to +12h)

### Web-only features

- Works offline as an installable PWA (service worker caching)
- Mobile-optimized: touch crosshair with frequency/time labels, long-press for selection, responsive toolbar
- Installable as standalone PWA on mobile
- No server, no backend -- all processing happens locally in the browser

## Supported formats

| Format | Bit depth | Sample rates |
|--------|-----------|-------------|
| PCM WAV | 16-bit, 24-bit, 32-bit | Any (tested up to 384 kHz) |
| IEEE Float WAV | 32-bit | Any |
| WAVE_FORMAT_EXTENSIBLE | All above | Any |
| BWF (Broadcast Wave) | All above | Any |

## Running

### Web version

No install needed -- just open [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/). To run locally:

```bash
cd apps/web
python3 -m http.server 8765
# open http://localhost:8765
```

### Desktop version

```bash
cd apps/desktop
npm install
npm start
```

See [apps/desktop/README.md](apps/desktop/README.md) for build and usage details.

## Documentation

- [Quick Start Guide](docs/QUICKSTART.md) -- get up and running in 5 minutes
- [Architecture](docs/ARCHITECTURE.md) -- module overview, data flow, shared code
- [Web App](docs/WEB_APP.md) -- web-specific features, PWA, mobile UX
- [Rebuild Spec](docs/REBUILD_SPEC.md) -- detailed specification for recreating the desktop app

## Repository structure

```
sound-explorer/
  docs/            ← shared documentation
  apps/
    desktop/       ← Electron version (large files, multi-file sessions)
    web/           ← browser version (GitHub Pages, PWA)
```

Both versions share the same FFT engine (Cooley-Tukey radix-2) and colormap code, kept as local copies in each app's source folder.

## How it was made

Vibecoded with [Claude Code](https://docs.anthropic.com/en/docs/claude-code). No frameworks, no bundlers, no npm (except Electron), no TypeScript, no build step. Plain ES modules served as static files.

## License

MIT
