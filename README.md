# Sound Explorer

A spectrogram viewer and audio player for exploring field recordings, built by [LOM](https://lom.audio). Load a WAV file, see its spectrogram, zoom into time-frequency regions of interest, and play them back at different speeds -- slowing down a 384 kHz bat call or speeding through hours of dawn chorus.

**Try it now: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

No install needed. Works on desktop and mobile. All processing happens locally in your browser -- your files never leave your device.

## Quick start

1. **Open** [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)
2. **Drag & drop** a WAV file onto the page, or click **Open Files**
3. **Scroll** to zoom in/out on the spectrogram
4. **Click** on the spectrogram to seek to that position
5. Press **Space** to play/pause
6. Change **Play as** speed to slow down ultrasonic content (e.g. 0.25x makes a 384 kHz recording audible)
7. **Select** a region by Shift-clicking, then **Export** it as a WAV file

### Live audio input

1. Click **Live** to capture audio from your microphone or sound card
2. Click **Rec** to record a segment
3. Click **Stop Live** -- the recording loads automatically for playback and export
4. Use **Play**, **Speed**, and **Export** just like with any WAV file

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| Left / Right | Seek -1s / +1s |
| Shift + Left / Right | Seek -10s / +10s |
| Scroll wheel | Zoom in / out |
| S | Zoom to selection |
| T | Trim to selection |
| U | Untrim (restore full view) |
| L | Toggle loop |
| Esc | Clear selection |

## Features

- **Spectrogram** -- parallel FFT across all CPU cores, tile cache for instant scrolling, six colormaps (viridis, magma, inferno, grayscale, green, hot), linear/logarithmic frequency scale, adjustable brightness/contrast and dynamic range, FFT sizes from 128 to 32768
- **FFT window functions** -- Hann (default for files), Blackman-Harris (default for live), Hamming, and Flat-top
- **Tape-speed playback** -- change playback speed (0.0625x--4x) with proportional pitch shift, like speeding up or slowing down a tape. Makes ultrasonic content audible or lets you skim through long recordings
- **Live audio input** -- capture audio from a microphone or sound card and view the spectrogram in real time. Select input device, adjust time window (2--30s), record segments and export as WAV with BWF timecode metadata
- **Time-frequency navigation** -- scroll to zoom, drag to pan, click to seek, frequency range presets (Full, Birds, Voice, Low, Mid), overview minimap for quick navigation
- **Selection and export** -- select a region, loop it, export as WAV. Preserves BWF timecode. Can export at altered speed for time-expanded recordings. Trim view to selection
- **Annotations** -- label time regions with notes, displayed as overlays on the spectrogram, export/import as JSON
- **Multichannel** -- mono downmix, per-channel view, split L|R display for stereo files
- **VU meter** -- per-channel level metering with peak hold, dBFS scale
- **Spectrum analyser** -- real-time frequency spectrum display in a sidebar panel with log-frequency axis, save and label snapshot lines for comparison, adjustable frequency range, resizable panel, fullscreen mode
- **PNG export** -- export spectrogram or spectrum analyser as publication-quality PNG with frequency/amplitude axes, time labels, wall-clock row (when available), settings info, and Sound Explorer branding
- **BWF/timecode** -- parses Broadcast Wave Format metadata for wall-clock timestamps, displayed on spectrogram axis and preserved through export
- **Session metadata** -- metadata forms (location, equipment, conditions, notes) with iXML and FRM sidecar support
- **Dark/light mode** -- toggle with the moon/sun button, saved between sessions
- **Offline support** -- works offline as an installable PWA after first visit

## Supported formats

| Format | Bit depth | Sample rates |
|--------|-----------|-------------|
| PCM WAV | 16-bit, 24-bit, 32-bit | Any (tested up to 384 kHz) |
| IEEE Float WAV | 32-bit | Any |
| WAVE_FORMAT_EXTENSIBLE | All above | Any |
| BWF (Broadcast Wave) | All above | Any |

Only WAV files are supported. If you have MP3, FLAC, or other formats, convert them to WAV first (e.g. using [FFmpeg](https://ffmpeg.org/): `ffmpeg -i input.mp3 output.wav`).

## Browser support

Works in Chrome, Firefox, Edge, and Safari. Chrome recommended for best performance with large files and live audio input.

## Two versions

Sound Explorer comes in two versions:

- **Web** -- runs in the browser, no install needed. Drag and drop WAV files, works offline as a PWA. Best for quick exploration and live audio input.
- **Desktop** (Electron) -- handles large files and multi-file sessions. Load an entire night of recordings as one continuous zoomable spectrogram with wall-clock time navigation.

Both versions share the same core: FFT computed in parallel Web Workers, tile-cached spectrogram rendering, tape-speed playback, and colormap-based visualization.

### Desktop-only features

- Multi-file sessions: load a folder of WAVs stitched into one timeline via BWF timecode
- Subsampled overview mode for 30+ minute recordings
- iXML metadata read/write, Field Recording Metadata (FRM) sidecar support
- Audio output device selection
- Batch annotation export
- Timecode offset correction (-12h to +12h)

## Running locally

### Web version

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
  docs/            <- shared documentation
  apps/
    desktop/       <- Electron version (large files, multi-file sessions)
    web/           <- browser version (GitHub Pages, PWA)
```

Both versions share the same FFT engine (Cooley-Tukey radix-2) and colormap code, kept as local copies in each app's source folder.

## How it was made

Vibecoded with [Claude Code](https://docs.anthropic.com/en/docs/claude-code). No frameworks, no bundlers, no npm (except Electron), no TypeScript, no build step. Plain ES modules served as static files.

## License

MIT
