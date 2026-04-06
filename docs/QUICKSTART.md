# Quick Start Guide

This guide walks you through installing Field Recording Explorer, opening your first recording, and exporting an annotated segment — all in about 5 minutes.

## 1. Install

You need [Node.js](https://nodejs.org/) 18 or later (which includes npm).

```bash
git clone https://github.com/mrkva/field-recording-explorer.git
cd field-recording-explorer
npm install
npm start
```

The app window opens immediately. No configuration files, environment variables, or databases required.

## 2. Open a recording

You have three options — pick whichever is easiest:

- **Drag and drop** a `.wav` file (or a folder of them) onto the app window.
- Click **Open Folder** to select a folder containing WAV files from the same recording session.
- Click **Open File(s)** to pick one or more individual WAV files.

If your files contain BWF (Broadcast Wave Format) timecodes, they are automatically sorted and stitched into a single continuous timeline. If not, they are sorted by filename.

Once loaded, you will see the spectrogram — the full recording displayed as a frequency-over-time visualization. A progress bar appears while FFT data is computed for the first time.

## 3. Navigate and listen

| What you want to do | How |
|---|---|
| Play/pause | Press `Space` |
| Zoom in to see detail | Pinch on trackpad, or press `+` |
| Zoom out to see the full picture | Press `F` (fit all) |
| Scroll through time | Two-finger horizontal scroll, or right-click drag |
| Seek to a point | Click anywhere on the spectrogram |
| Jump to a wall-clock time | Type a time like `22:35` in the toolbar input and press Enter |
| Make quiet sounds louder | Drag the **Audio Gain** slider in the bottom bar (up to +60 dB) |

## 4. Select, annotate, and export

Here is a complete workflow from selection to saved file:

1. **Select a range** — Click and drag horizontally on the spectrogram. The selected region highlights and begins looping automatically so you can listen closely.

2. **Fine-tune** — Edit the **From** and **To** time fields that appear in the toolbar, or pick a preset duration (5s, 10s, 30s, etc.) from the **Dur** dropdown. Press `S` to zoom the view into your selection.

3. **Annotate** — Click the **Annotate** button. Type a short note (e.g., "owl call") and click **Save Annotation**. A colored overlay appears on the spectrogram marking this region.

4. **Export** — Click **Export WAV**. Choose a save location. The app writes a bit-perfect copy of the original audio for that time range — no transcoding, no quality loss. The filename includes ISO 8601 timestamps for easy sorting.

5. **Save your annotations** — Click **Annotations** in the toolbar to open the sidebar, then click **Save**. This writes a `.json` file (and a companion `ffmpeg` shell script). Next time you open the same recording, annotations are loaded automatically if the JSON file is in the same folder.

## 5. Build a distributable (optional)

To create a standalone installer you can share:

```bash
npm run dist
```

This produces a `.dmg` (macOS), `.exe` (Windows), or `.AppImage`/`.deb` (Linux) in the `dist/` folder.

## Common gotchas

### "Could not read file paths" on drag and drop
This can happen if you're running an older Electron version. The app requires Electron 33+ for `webUtils.getPathForFile()` support. Run `npm install` to make sure you have the correct version.

### Spectrogram is slow on very long recordings
When viewing 30+ minutes zoomed all the way out, the initial FFT computation takes a few seconds. This is normal — subsequent scrolling is instant because tiles are cached. If it takes more than 10 seconds, try reducing the FFT size (bottom bar) from 2048 to 1024.

### No wall-clock times shown
Wall-clock navigation only works when your WAV files contain BWF metadata (a `bext` chunk with origination date/time). Standard WAV files without this metadata will only show position-based times. Most professional field recorders (Wildlife Acoustics, Sound Devices, etc.) write BWF metadata by default.

### Audio sounds distorted at high gain
The Audio Gain slider amplifies everything — including noise. At +40 dB or higher, background noise becomes very loud. This is expected. The gain does not affect exported files; it only changes what you hear during playback.

### Exported file plays at the wrong speed
If you used the **Play as** speed selector (e.g., 0.5x for slowed playback) and then clicked **Export WAV**, the export is at the *original* speed and sample rate. To export with the speed change baked in, use the **Export 0.5x** button that appears next to Export WAV when a non-native speed is selected.
