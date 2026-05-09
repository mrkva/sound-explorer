# Live FFT Spectrum — Fast Rendering Technical Solution

This document describes how the **Spectrum** view in `sound-explorer` renders a
live FFT frequency-domain plot at 60 fps with negligible CPU cost. It is
written as a self-contained spec so another Claude instance can replicate the
implementation in a different project.

> Scope: the **Spectrum** (live frequency-domain line plot, log-X / dB-Y).
> NOT the Spectrogram (2D time-frequency heatmap) — that is a different view.

---

## 1. Where the implementation lives

| Concern | Web (`apps/web`) | Desktop (`apps/desktop`) |
|---|---|---|
| Markup (canvas + controls) | `index.html` lines 295–312 | `index.html` (mirror) |
| State init | `js/app.js` lines 26–35 | `src/app.js` lines 66–76 |
| Render loop | `js/app.js` `_startSpectrumAnalyser` lines 1330–1459 | `src/app.js` lines 2288–2368 |
| Line drawing | inlined `drawLine()` lines 1422–1445 | static `_drawSpectrumLine` lines 2255–2278 |
| Save/clear/list | lines 1468–1500 | lines 2377–2439 |
| FFT data source (mic) | `js/live-capture.js` lines 101–106, 235–243 | `src/live-capture.js` (same) |
| FFT data source (file) | `js/audio-engine.js` lines 88–93, 223–231 | `src/audio-engine.js` (same) |
| CSS | `css/*.css` `.spectrum-*` rules (line 562+) | `styles/*.css` |

Both apps share the same architecture; the web version is the cleaner
reference.

---

## 2. The core idea — why it is fast

The whole pipeline is:

```
mic / <audio> → MediaStreamSource / MediaElementSource
              → AnalyserNode (fftSize=8192, smoothingTimeConstant=0.7)
              → getFloatFrequencyData(reusedFloat32Array)
              → single 2D-canvas Path stroke (≈ 4096 lineTo calls)
```

There is **no custom FFT, no Worker, no WebGL, no SVG, no per-bin DOM**. The
browser does the FFT in native code; we draw one polyline per frame.

The performance comes from six decisions, in rough order of impact:

1. **Use the Web Audio `AnalyserNode` for the FFT.** It runs in the audio
   thread in native code. The JS main thread never sees raw PCM.
2. **Reuse a single `Float32Array` for the frequency buffer.** Allocated once
   at setup; `getFloatFrequencyData(buf)` writes dB values into it in place,
   so there is zero per-frame allocation.
3. **Lean on `smoothingTimeConstant`** for visual smoothing. The analyser
   does an exponential moving average internally — you get smooth motion
   without any JS-side filtering.
4. **One Canvas2D `Path` per line.** A single `beginPath` … many `lineTo` …
   one `stroke`. No `fillRect` per bin, no separate sub-paths.
5. **Resize the canvas only when its dimensions actually change.** DPR-aware
   transform is set once per resize, not per frame.
6. **Skip the entire frame when nothing has changed** (no live data and no
   saved overlay lines). The rAF callback re-arms itself but exits early.

Together these keep a frame around 0.3–1.0 ms on a typical laptop, well below
the 16.6 ms budget at 60 fps.

---

## 3. Audio graph and FFT setup

Set up once, when the audio source is created:

```javascript
// In live-capture.js (mic) and audio-engine.js (file playback)
this.spectrumAnalyser = audioCtx.createAnalyser();
this.spectrumAnalyser.fftSize = 8192;            // ~5.86 Hz bins at 48 kHz
this.spectrumAnalyser.smoothingTimeConstant = 0.7; // free EMA smoothing
this._spectrumBuffer = new Float32Array(
  this.spectrumAnalyser.frequencyBinCount         // 4096 bins
);
sourceNode.connect(this.spectrumAnalyser);
// IMPORTANT for mic input: do NOT connect the analyser to destination,
// otherwise you get monitor feedback. AnalyserNode is a tap, not a sink —
// the source must connect somewhere (e.g. another AnalyserNode or a muted
// gain node) for it to pull samples; for file playback the existing
// gainNode → destination chain already does this.
```

Tunables and what they trade:

| Parameter | Effect | Recommended |
|---|---|---|
| `fftSize` | larger = finer Hz resolution, slower update | `8192` |
| `smoothingTimeConstant` | 0 = jittery, 0.9 = sluggish | `0.7` |
| `minDecibels` / `maxDecibels` | clip range of returned dB | leave defaults (-100 / -30) and clip in JS |

Expose a single getter:

```javascript
getSpectrumData() {
  if (!this.spectrumAnalyser) return null;
  this.spectrumAnalyser.getFloatFrequencyData(this._spectrumBuffer);
  return {
    data: this._spectrumBuffer,        // Float32Array of dB, length = binCount
    binCount: this.spectrumAnalyser.frequencyBinCount,
    sampleRate: this.audioCtx.sampleRate,
  };
}
```

`data` is shared, not copied — the next call overwrites it. Snapshot with
`new Float32Array(data)` only when the user saves a reference line.

---

## 4. The render loop

A single `requestAnimationFrame` loop. Pseudo-structure:

```javascript
_startSpectrumAnalyser() {
  if (this._spectrumRAF) return;                    // idempotent start
  const canvas = document.getElementById('spectrum-canvas');
  const ctx = canvas.getContext('2d');

  const draw = () => {
    this._spectrumRAF = requestAnimationFrame(draw); // re-arm first

    const spec = this._currentSpectrumSource()?.getSpectrumData();

    // Early-out when there's nothing to show.
    if (!spec && this._spectrumSavedLines.length === 0) return;

    // Resize only on change.
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.parentElement.clientWidth;
    const h = canvas.parentElement.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Layout, axes, mappings ... (see §5)
    // Grid ...                                       (see §5)
    // For each saved line: drawLine(line, ..., fill=true, alpha=0.6)
    // drawLine(spec, ..., fill=false, alpha=1, color='#ffffff')
  };

  this._spectrumRAF = requestAnimationFrame(draw);
}

_stopSpectrumAnalyser() {
  if (this._spectrumRAF) cancelAnimationFrame(this._spectrumRAF);
  this._spectrumRAF = null;
}
```

Notes:

- **rAF re-arms itself first**, so an early `return` still keeps the loop
  alive for the next frame.
- The loop is started when the user opens the Spectrum panel and stopped
  when the panel is hidden. It does not run while the panel is offscreen.
- No setInterval, no Worker, no MessageChannel — `requestAnimationFrame`
  is naturally throttled by the browser when the tab is hidden.

---

## 5. Coordinate mapping and grid

Frequency uses a **logarithmic** X axis (musically meaningful) and dB uses a
**linear** Y axis from −120 to 0 dB.

```javascript
const pad = { top: 8, right: 8, bottom: 20, left: 36 };
const pw = w - pad.left - pad.right;
const ph = h - pad.top  - pad.bottom;

const dbMin = -120, dbMax = 0;
const sampleRate = spec ? spec.sampleRate : 48000;
const nyquist   = sampleRate / 2;
const freqMin   = Math.max(1, this._spectrumFreqMin || 20);
const freqMax   = Math.min(nyquist, this._spectrumFreqMax || nyquist);

const logMin = Math.log10(freqMin);
const logMax = Math.log10(freqMax);

const freqToX = (f) =>
  pad.left + ((Math.log10(f) - logMin) / (logMax - logMin)) * pw;
const dbToY = (db) =>
  pad.top  + ((dbMax - db) / (dbMax - dbMin)) * ph;
```

Grid (drawn before the lines so they sit on top):

```javascript
ctx.strokeStyle = 'rgba(255,255,255,0.08)';
ctx.lineWidth   = 1;
ctx.font        = '9px -apple-system, sans-serif';
ctx.fillStyle   = 'rgba(255,255,255,0.3)';

// Frequency ticks (decade + 2/5 sub-ticks)
const freqTicks = [20,50,100,200,500,1000,2000,5000,10000,20000,50000,100000,200000];
for (const f of freqTicks) {
  if (f < freqMin || f > freqMax) continue;
  const x = freqToX(f);
  ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
  ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x, pad.top + ph + 4);
}

// dB ticks every 20 dB
for (let db = dbMin; db <= dbMax; db += 20) {
  const y = dbToY(db);
  ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
  ctx.fillText(String(db), pad.left - 4, y);
}
```

The `freqTicks` and dB ticks are drawn as separate sub-paths but all under
one strokeStyle, which is cheap. You could merge them into a single `Path2D`
if profiling shows it matters; in practice it does not.

---

## 6. Drawing one spectrum line

This is the hot loop. Every frame, every line goes through it.

```javascript
function drawLine(ctx, data, binCount, sr, color, alpha, fill,
                  freqToX, dbToY, dbMin, freqMin, freqMax) {
  const binHz = sr / (binCount * 2);   // FFT bin width in Hz
  ctx.beginPath();
  let started = false;
  for (let i = 1; i < binCount; i++) { // skip DC bin 0
    const f = i * binHz;
    if (f < freqMin || f > freqMax) continue;
    const x  = freqToX(f);
    const db = data[i] < dbMin ? dbMin : (data[i] > 0 ? 0 : data[i]);
    const y  = dbToY(db);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else            ctx.lineTo(x, y);
  }
  if (fill && started) {
    ctx.lineTo(freqToX(freqMax), dbToY(dbMin));
    ctx.lineTo(freqToX(freqMin), dbToY(dbMin));
    ctx.closePath();
    ctx.fillStyle = hexToRgba(color, alpha * 0.15);
    ctx.fill();
  }
  ctx.strokeStyle = hexToRgba(color, alpha);
  ctx.lineWidth   = 1.5;
  ctx.stroke();
}
```

Why this is fast:

- **One `beginPath` / one `stroke` per line.** The browser batches the
  4096 `lineTo` segments into a single GPU-accelerated stroke.
- **Inline clip with `continue`** instead of clipping with a separate
  `ctx.clip()` rect — clipping is more expensive than skipping.
- **Cheap dB clamp** (`data[i] < dbMin ? dbMin : ...`) avoids
  `Math.max(...)` overhead in a tight loop.
- **No per-bin allocation, no array copy.** We iterate the analyser
  buffer directly.
- **Skip DC** (`i = 1`) so the line starts at a meaningful frequency.

If you want optional per-bin **density reduction** for very wide canvases
(e.g. >2× more bins than pixels), you can stride the loop:
`const stride = Math.max(1, Math.floor(binCount / pw));`. The reference
implementation does not bother — modern Canvas2D handles 4096 lineTos in
under a millisecond.

---

## 7. Saved reference lines

The user can press **Save Line** to freeze the current spectrum and
overlay it as a coloured curve. Implementation is trivial:

```javascript
this._spectrumColors = [
  '#5B9BD5','#8B5CF6','#D946EF','#06B6D4',
  '#F59E0B','#10B981','#EF4444','#F97316',
];

_saveSpectrumLine() {
  const spec = this._currentSpectrumSource()?.getSpectrumData();
  if (!spec?.data) return;
  this._spectrumSavedLines.push({
    data: new Float32Array(spec.data),  // copy! buffer is reused
    binCount: spec.binCount,
    sampleRate: spec.sampleRate,
    color: this._spectrumColors[this._spectrumSavedLines.length
                                 % this._spectrumColors.length],
    label: `Capture ${this._spectrumSavedLines.length + 1}`,
  });
}
```

The render loop draws saved lines first (so the live white line sits on
top) with `alpha=0.6` and `fill=true`. This is also what makes the loop
run when paused — saved lines still need to be redrawn on resize.

---

## 8. HTML scaffolding

Minimal markup the loop expects:

```html
<div class="spectrum-canvas-wrap">
  <canvas id="spectrum-canvas"></canvas>
</div>
<div class="spectrum-controls">
  <button id="btn-spectrum-save">Save Line</button>
  <button id="btn-spectrum-clear">Clear All</button>
  <button id="btn-spectrum-export">↓ PNG</button>
  <button id="btn-spectrum-fullscreen">⛶</button>
</div>
<div class="spectrum-range">
  <input id="spectrum-freq-min" type="number" value="20"  min="1">
  <input id="spectrum-freq-max" type="number" placeholder="max" min="1">
</div>
<div id="spectrum-lines-list"></div>
```

CSS only needs `.spectrum-canvas-wrap { position: relative; width: 100%;
height: 100%; }` and `.spectrum-canvas-wrap canvas { width: 100%; height:
100%; display: block; }`. The DPR scaling is handled in JS.

---

## 9. Anti-patterns to avoid

These are the choices I see go wrong in slow spectrum analysers:

- **Custom JS FFT** (e.g. dsp.js, fft.js) running on each `onaudioprocess`.
  Slower, allocates, and blocks the audio thread. Use `AnalyserNode`.
- **Drawing 4096 `fillRect` bars instead of one polyline.** Each
  `fillRect` is its own draw call; bars also alias badly on log axes.
- **Resizing the canvas every frame** (`canvas.width = canvas.width`) —
  forces a full re-allocate of the backing store and clears state. Only
  resize when dimensions change.
- **Allocating `new Float32Array(...)` per frame** to receive the FFT
  data. Allocate once at setup; reuse forever.
- **Running rAF and `setInterval` together.** Pick one. rAF is correct.
- **Smoothing in JS** with your own ring buffer. The analyser already
  does exponential smoothing — adjust `smoothingTimeConstant`.
- **Connecting the AnalyserNode to `audioCtx.destination` for mic
  input.** This causes monitoring feedback. The analyser pulls samples
  via the source connection; it doesn't need to be connected downstream.
- **Linear X axis.** Looks wrong for audio. Always log-scale frequency.

---

## 10. Replication checklist

To clone this into a different project:

1. Add `<canvas id="spectrum-canvas">` inside a sized container.
2. Create one `AnalyserNode` per audio source you want to display
   (`fftSize=8192`, `smoothingTimeConstant=0.7`), wire the source into it,
   and allocate `new Float32Array(analyser.frequencyBinCount)` once.
3. Expose `getSpectrumData()` returning `{ data, binCount, sampleRate }`.
4. Implement `_startSpectrumAnalyser()` / `_stopSpectrumAnalyser()` with a
   single `requestAnimationFrame` loop following §4.
5. Inside the loop: DPR-aware resize-on-change, `clearRect`, log/linear
   mapping helpers (§5), grid (§5), draw saved lines, draw live line
   (§6).
6. Add Save / Clear buttons that push/clear into `_spectrumSavedLines`
   (§7), copying the buffer.
7. Hook freq-min/freq-max inputs to `this._spectrumFreqMin/Max` and let
   the loop pick them up next frame — no recompute needed.
8. Start the loop on panel-open, stop it on panel-close.

That is the entire fast path. About 130 lines of JS plus ~10 lines of
audio-graph setup.
