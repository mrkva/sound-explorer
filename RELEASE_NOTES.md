## What's New in v0.8.4

### New Features

#### Desktop & Web
- **LOM logo in PNG exports** — Spectrogram and spectrum PNG exports now display the LOM logo in the branding bar instead of a placeholder character
- **Source filename in PNG exports** — Exported PNGs are named after the source WAV file (e.g. `recording_spectrogram.png`, `recording_spectrum.png`) instead of generic names
- **Waveform overview progress** — Status bar shows loading progress while the overview waveform is being computed
- **Startup disclaimer** — First-launch dialog warns users that this is experimental software and recommends working only with backed-up files
- **Improved PNG export layout** — Logo and app name positioned at the left edge of the branding bar; tighter spacing between time axis labels and footer

#### Desktop Only
- **Normalize confirmation dialog** — Destructive normalize operation now requires explicit user confirmation before modifying files
- **PNG export save dialog** — Spectrogram and spectrum PNG exports open a native save dialog, defaulting to the source file's folder

### Bug Fixes

#### Desktop & Web
- **Fixed spectrogram re-rendering on play/stop** — Play and stop button glyph height differences caused the toolbar to rewrap, triggering unnecessary spectrogram recomputes. Fixed with a dimension significance threshold (changes ≤3px are ignored)
- **Fixed layout shift from overview canvas** — Overview waveform canvas now uses `visibility` instead of `display` to prevent layout recalculation when it appears
- **Improved resize handling** — Canvas dimensions sync immediately on resize, but expensive FFT recomputation is debounced (250ms), eliminating stuck "rendering" overlays and jittery VU meters
- **Render worker reliability** — Added error handlers and timeouts to render worker promises, preventing silent hangs
- **Smoother playback during overview loading** — Overview waveform reads use smaller chunks with yields to reduce contention with the audio engine

#### Desktop Only
- **Fixed normalize crash** — Normalize operation crashed due to incorrect file descriptor cache access
- **Fixed PNG export filename** — Export used a non-existent property for the source filename, causing fallback to generic names
