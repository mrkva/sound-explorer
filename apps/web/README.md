# Sound Explorer

A browser-based spectrogram viewer and audio player for ultrasonic field recordings, built by [LOM](https://lom.audio).

**Try it live: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

## Your data stays on your machine

Sound Explorer runs **entirely in your browser**. There is no server, no backend, no database, no analytics, no cookies, no tracking.

When you open a WAV file, it is read directly from your hard drive by your browser using the [File API](https://developer.mozilla.org/en-US/docs/Web/API/File_API). The audio data is never uploaded, transmitted, or sent anywhere. The application is a set of static HTML, CSS, and JavaScript files -- once the page loads, it could work completely offline. Your recordings never leave your computer.

## What it does

Sound Explorer is designed for biology students and field recordists who work with ultrasonic recorders (Wildlife Acoustics, AudioMoth, Pettersson, etc.) capturing bats, insects, and other wildlife at high sample rates (192kHz, 256kHz, 384kHz).

- **Spectrogram rendering** -- computes and displays spectrograms using FFT processed in parallel Web Workers. Supports multiple colormaps (viridis, magma, inferno, etc.), adjustable FFT size (128--32768), and linear/logarithmic frequency scales.
- **Tape-speed playback** -- slows down ultrasonic recordings so you can hear them. A 384kHz bat call played at 0.125x becomes audible. Works by writing a modified sample rate into the WAV header, so the browser plays fewer samples per second = lower pitch, slower speed. Just like slowing down a tape.
- **Time-frequency navigation** -- scroll wheel to zoom, right-click drag to pan, left-click drag to select regions. Frequency presets for bats (15--150kHz), birds (1--12kHz), and audible range.
- **WAV export** -- select a region and export it as a standard WAV file. Preserves BWF timecode when available. Can also export at the current playback speed (writes modified sample rate in header, raw PCM data unchanged).
- **BWF/timecode support** -- parses Broadcast Wave Format metadata for wall-clock timestamps, so you know exactly when in the night a bat call occurred.
- **Annotations** -- label time regions with notes, export/import as JSON.
- **Multichannel support** -- mono downmix, individual channel selection, or split L|R view.
- **Spectrum analyser** -- real-time frequency spectrum sidebar with save/compare snapshot lines, adjustable range, fullscreen mode.
- **PNG export** -- export spectrogram or spectrum as publication-quality images with axes, wall-clock labels, settings info, and branding.

## How it was made

This project was vibecoded with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic's AI coding agent). The entire application -- WAV parser, FFT engine, spectrogram renderer, audio playback system, UI -- was generated through conversation with Claude, guided by a detailed specification document.

No frameworks, no bundlers, no npm, no TypeScript, no build step. Just plain ES modules served as static files.

## Technical details

The app is ~3500 lines of vanilla JavaScript across 6 files:

| File | Purpose |
|------|---------|
| `js/wav-parser.js` | WAV/BWF file parser, chunk-based reading, PCM decoding (16/24/32-bit int, 32-bit float), WAV blob construction for export |
| `js/fft-worker.js` | Web Worker running Cooley-Tukey radix-2 FFT with pre-computed twiddle factor lookup tables |
| `js/render-worker.js` | Web Worker that converts FFT magnitude data to spectrogram pixels with color LUT mapping |
| `js/spectrogram.js` | Canvas renderer, tile caching, mouse interaction, zoom/pan/selection |
| `js/audio-engine.js` | Playback engine using `<audio>` element with baked-in speed via WAV header manipulation |
| `js/app.js` | Main controller wiring everything together |

Key design decisions:
- **Never loads entire files into memory** -- reads chunks via `file.slice()` (max 8MB at a time)
- **FFT computed in a pool of Web Workers** -- uses all available CPU cores
- **Playback speed baked into WAV header** -- avoids browser `playbackRate` glitches at extreme speeds
- **Spectrogram tiles cached** -- moving around a file you've already viewed is instant

## Browser support

Works in modern Chrome, Firefox, and Edge. Safari works with minor cosmetic differences (a known Safari compositor quirk can cause a brief cursor stutter during playback).

## Running locally

No build step needed. Serve the files with any static HTTP server:

```bash
python3 -m http.server 8765
```

Then open `http://localhost:8765` in your browser.

## License

MIT
