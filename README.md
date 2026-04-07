# Sound Explorer

A spectrogram viewer and audio player for exploring field recordings, built by [LOM](https://lom.audio). Load a WAV file, see its spectrogram, zoom into time-frequency regions of interest, and play them back at different speeds -- slowing down a 384kHz bat call or speeding through hours of dawn chorus.

**Try it now: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

Sound Explorer comes in two versions:

- **Web** -- runs in the browser, no install needed. Drag and drop WAV files, works offline as a PWA. Best for quick exploration of individual files.
- **Desktop** (Electron) -- handles large files and multi-file sessions. Load an entire night of recordings as one continuous zoomable spectrogram with wall-clock time navigation.

Both versions share the same core: FFT computed in parallel Web Workers, tile-cached spectrogram rendering, tape-speed playback, and colormap-based visualization.

## Features

- **Spectrogram** -- parallel FFT across all CPU cores, tile cache for instant scrolling, six colormaps (viridis, magma, inferno, grayscale, green, hot), linear/logarithmic frequency scale, adjustable gain and dynamic range, FFT sizes from 128 to 32768
- **Tape-speed playback** -- change playback speed (0.0625x--4x) with proportional pitch shift, like speeding up or slowing down a tape. Useful for making ultrasonic content audible or skimming through long recordings
- **Time-frequency navigation** -- scroll to zoom, drag to pan, click to seek, frequency range presets
- **Selection and export** -- select a region, loop it, export as WAV. Preserves BWF timecode. Can export at altered speed
- **Annotations** -- label time regions with notes, displayed as overlays on the spectrogram, export/import as JSON
- **Multichannel** -- mono downmix, per-channel view, split L|R display, per-channel VU meters
- **BWF/timecode** -- parses Broadcast Wave Format metadata for wall-clock timestamps

### Desktop-only features

- Multi-file sessions: load a folder of WAVs stitched into one timeline via BWF timecode
- Subsampled overview mode for 30+ minute recordings
- iXML metadata read/write, Field Recording Metadata (FRM) sidecar support
- Audio output device selection
- Batch annotation export

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

## Repository structure

```
sound-explorer/
  apps/
    desktop/       ← Electron version (large files, multi-file sessions)
    web/           ← browser version (GitHub Pages, PWA)
```

Both versions share the same FFT engine (Cooley-Tukey radix-2) and colormap code, kept as local copies in each app's source folder.

## How it was made

Vibecoded with [Claude Code](https://docs.anthropic.com/en/docs/claude-code). No frameworks, no bundlers, no npm (except Electron), no TypeScript, no build step. Plain ES modules served as static files.

## License

MIT
