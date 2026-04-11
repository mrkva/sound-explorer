# Web App

The web version of Sound Explorer runs entirely in the browser. No server, no backend, no install. Audio data never leaves the user's computer.

**Live: [mrkva.github.io/sound-explorer](https://mrkva.github.io/sound-explorer/)**

## How it differs from the desktop app

| Aspect | Web | Desktop |
|--------|-----|---------|
| File I/O | Browser File API (`file.slice()`) | Node.js `fs` via Electron IPC |
| Multi-file sessions | No -- individual files only | Yes -- folder loading, BWF timeline stitching |
| Session manager | None | `Session` class with wall-clock mapping |
| Audio playback | WAV blob URL with speed baked into header | HTTP Range requests to local server |
| WAV parser | `wav-parser.js` (reads from `File` objects) | `bwf-parser.js` (reads from `ArrayBuffer` via IPC) |
| Subsampled mode | No -- FFT subsampling only | Yes -- scattered IPC reads for 30+ min views |
| Sidecar files | No filesystem access | iXML embed, FRM sidecar read/write |
| Audio output device | Browser default only | Selectable via `setSinkId()` |
| Offline support | Service worker (PWA) | Native app |
| Mobile support | Full responsive design, touch gestures | Desktop-only UI |

## Architecture

```
index.html          Static layout: drop zone, toolbar, canvas, bottom bar, modals
sw.js               Service worker: app shell caching, update notifications
manifest.json       PWA manifest (standalone display mode)
js/
  app.js            App controller: file loading, live mode, VU meter, _updateUI()
  spectrogram.js    Spectrogram renderer: FFT, worker pool, tile cache, canvas, touch
  audio-engine.js   Audio playback: Web Audio API, gain, VU metering
  wav-parser.js     WAV/BWF parser via File API (no Node.js)
  fft-core.js       Window functions, Cooley-Tukey FFT, magnitude computation
  fft-worker.js     Web Worker: parallel FFT computation
  render-worker.js  Web Worker: pixel rendering with colormap LUTs
  colormaps.js      Colormap definitions and 256-entry LUT builder
  ixml.js           iXML metadata parsing and serialization
  frm.js            FRM sidecar parsing and serialization
  live-capture.js   Live audio capture via getUserMedia + AudioWorklet
  version.js        App version string
css/
  main.css          Dark/light themes via CSS custom properties
img/
  icon.svg          App icon (SVG)
  icon-192.png      PWA icon 192x192
  icon-512.png      PWA icon 512x512
  logo_black.png    LOM logo (dark theme)
  logo_white.png    LOM logo (light theme)
```

## Unified file/live experience

The web app uses a single `_updateUI()` method to manage toolbar visibility based on app state, rather than separate modes with teardown/rebuild. The state flags are:

- `hasFile` -- one or more WAV files loaded
- `isLive` -- live audio capture is active
- `isFrozen` -- live capture stopped but spectrogram image remains for exploration
- `hasRecording` -- a live recording blob exists for export

Controls appear and disappear contextually:

| Controls | Visible when |
|----------|-------------|
| Open, Live, VU, Theme | Always |
| Play, Stop, Speed, Export | hasFile |
| Zoom, Fit | hasFile or isFrozen |
| Selection, Trim, Go To | hasFile |
| Annotations, Metadata | hasFile |
| Input device, Time window | isLive |
| Record, Save recording | isLive / hasRecording |

The "Live" button toggles between starting and stopping capture. Stopping freezes the spectrogram for exploration (zoom, crosshair) rather than clearing it.

## Live capture

The web app's live spectrogram renders on the main thread using:

- **Color LUT** -- pre-built 256-entry RGBA table from `colormaps.js`, rebuilt only when the colormap changes
- **Y-bin mapping cache** -- frequency-to-pixel lookup, invalidated on frequency range or scale changes
- **Column cache** -- circular buffer of FFT magnitude arrays, only new columns computed each frame
- **Gate threshold** -- suppresses display below a configurable noise floor

During live capture, the VU meter shows real-time peak and RMS levels with ballistic smoothing (instant attack, 80 dB/s decay).

## Mobile UX

The web app is responsive down to phone-sized screens:

- **Toolbar**: horizontal scroll, no wrapping. Logo and version inline with buttons
- **Touch crosshair**: single-finger touch shows a crosshair overlay with frequency and time labels. Moves with the finger for frequency exploration
- **Long-press selection**: press and hold for 1 second, then drag to create a time selection. Brief haptic feedback on activation
- **Tap to seek/clear**: tap clears selection if one exists, otherwise seeks to that time position
- **Two-finger pan**: pinch to zoom, two-finger drag to pan
- **Bottom bar**: collapsed by default on mobile, expandable via settings button
- **Info strip**: hidden during live capture on mobile to save vertical space
- **Standalone PWA**: installs as a standalone app (no browser chrome) on mobile devices

## PWA and offline

The service worker (`sw.js`) caches the entire app shell on install:

- All HTML, CSS, and JS files
- Icons and logos
- Manifest

Strategy: serve from cache first, fetch update in background. When a new version is detected, the service worker posts a `SW_UPDATED` message to all open tabs. The `CACHE_VERSION` in `sw.js` must match `VERSION` in `version.js`.

## Data privacy

All audio processing happens locally:

- Files read via `File API` -- never uploaded
- FFT computed in Web Workers -- no network requests
- Audio played via local blob URLs
- Live capture stays in the browser's audio subsystem
- No analytics, cookies, tracking, or external requests after initial page load
