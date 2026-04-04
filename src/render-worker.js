/**
 * Spectrogram render worker – offloads pixel-level spectrogram rendering
 * from the main thread.
 *
 * Receives: { type: 'render', frames, freqBins, numFrames, width, height,
 *             sampleRate, fftSize, minFreq, maxFreq, logFrequency,
 *             gainDB, dynamicRangeDB, colorPreset }
 * Returns:  { type: 'rendered', bitmap: ImageBitmap } (transferred)
 */

// ── Colormap presets ──────────────────────────────────────────────────────
const PRESETS = {
  viridis: [
    [0.0, 68, 1, 84], [0.13, 72, 36, 117], [0.25, 65, 68, 135],
    [0.38, 53, 95, 141], [0.50, 42, 120, 142], [0.63, 33, 145, 140],
    [0.75, 34, 168, 132], [0.82, 68, 191, 112], [0.88, 122, 209, 81],
    [0.94, 189, 223, 38], [1.0, 253, 231, 37]
  ],
  magma: [
    [0.0, 0, 0, 4], [0.13, 28, 16, 68], [0.25, 79, 18, 123],
    [0.38, 129, 37, 129], [0.50, 181, 54, 122], [0.63, 229, 89, 100],
    [0.75, 251, 136, 97], [0.85, 254, 188, 118], [0.94, 254, 228, 152],
    [1.0, 252, 253, 191]
  ],
  inferno: [
    [0.0, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109],
    [0.38, 136, 34, 106], [0.50, 186, 54, 85], [0.63, 227, 89, 51],
    [0.75, 249, 140, 10], [0.85, 249, 201, 50], [0.94, 240, 249, 33],
    [1.0, 252, 255, 164]
  ],
  grayscale: [
    [0.0, 0, 0, 0], [1.0, 255, 255, 255]
  ],
  green: [
    [0.0, 0, 0, 0], [0.25, 0, 30, 0], [0.5, 0, 100, 10],
    [0.75, 30, 200, 30], [1.0, 180, 255, 100]
  ],
  hot: [
    [0.0, 0, 0, 0], [0.33, 180, 0, 0], [0.66, 255, 200, 0],
    [1.0, 255, 255, 255]
  ]
};

// Pre-build a 256-entry LUT for a given colormap (avoids per-pixel interpolation)
function buildColorLUT(presetName) {
  const stops = PRESETS[presetName] || PRESETS.viridis;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const value = i / 255;
    let r = 0, g = 0, b = 0;
    for (let s = 0; s < stops.length - 1; s++) {
      if (value <= stops[s + 1][0]) {
        const t = (value - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        r = Math.round(stops[s][1] + t * (stops[s + 1][1] - stops[s][1]));
        g = Math.round(stops[s][2] + t * (stops[s + 1][2] - stops[s][2]));
        b = Math.round(stops[s][3] + t * (stops[s + 1][3] - stops[s][3]));
        break;
      }
      if (s === stops.length - 2) {
        const last = stops[stops.length - 1];
        r = last[1]; g = last[2]; b = last[3];
      }
    }
    lut[i * 3]     = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

self.onmessage = function(e) {
  const { type } = e.data;

  if (type === 'render') {
    const {
      frames, freqBins, numFrames, width, height,
      sampleRate, fftSize, minFreq, maxFreq, logFrequency,
      gainDB, dynamicRangeDB, colorPreset
    } = e.data;

    const spectWidth = width;
    const spectHeight = height;

    // Frequency bin resolution
    const binRes = sampleRate / fftSize;
    const minBin = Math.max(1, Math.floor(minFreq / binRes));
    const maxBin = Math.min(Math.ceil(maxFreq / binRes), freqBins - 1);
    const visibleBins = maxBin - minBin;

    // Y → bin lookup (linear interpolation)
    const binLookupLow = new Int32Array(spectHeight);
    const binLookupFrac = new Float32Array(spectHeight);
    const logMinFreq = Math.log(Math.max(minFreq, 20));
    const logMaxFreq = Math.log(Math.max(maxFreq, 21));

    for (let y = 0; y < spectHeight; y++) {
      const ratio = (spectHeight - 1 - y) / spectHeight;
      let binF;
      if (logFrequency) {
        const logFreq = logMinFreq + ratio * (logMaxFreq - logMinFreq);
        binF = Math.exp(logFreq) / binRes;
      } else {
        binF = minBin + ratio * visibleBins;
      }
      binF = Math.max(minBin, Math.min(binF, maxBin));
      binLookupLow[y] = Math.floor(binF);
      binLookupFrac[y] = binF - Math.floor(binF);
    }

    // Build color LUT (256 entries → avoids per-pixel colormap interpolation)
    const lut = buildColorLUT(colorPreset);

    const floor = -dynamicRangeDB;
    const invRange = 255 / dynamicRangeDB;

    // Render pixels
    const pixels = new Uint8ClampedArray(spectWidth * spectHeight * 4);

    for (let x = 0; x < spectWidth; x++) {
      const frameIdx = Math.min(Math.floor(x * numFrames / spectWidth), numFrames - 1);
      const spectrum = frames[frameIdx];
      if (!spectrum) continue;

      for (let y = 0; y < spectHeight; y++) {
        const bin0 = binLookupLow[y];
        const frac = binLookupFrac[y];

        let raw0 = spectrum[bin0];
        if (raw0 === undefined || raw0 !== raw0) raw0 = -120; // NaN check via self-inequality
        let raw;
        if (frac > 0 && bin0 + 1 <= maxBin) {
          let raw1 = spectrum[bin0 + 1];
          if (raw1 === undefined || raw1 !== raw1) raw1 = -120;
          raw = raw0 + frac * (raw1 - raw0);
        } else {
          raw = raw0;
        }

        const db = raw + gainDB;
        // Map to 0..255 using LUT
        const lutIdx = Math.max(0, Math.min(255, Math.round((db - floor) * invRange))) | 0;

        const px = (y * spectWidth + x) * 4;
        const ci = lutIdx * 3;
        pixels[px]     = lut[ci];
        pixels[px + 1] = lut[ci + 1];
        pixels[px + 2] = lut[ci + 2];
        pixels[px + 3] = 255;
      }
    }

    // Create ImageData and convert to ImageBitmap for zero-copy transfer
    const imageData = new ImageData(pixels, spectWidth, spectHeight);
    createImageBitmap(imageData).then(bitmap => {
      self.postMessage({ type: 'rendered', bitmap, width: spectWidth, height: spectHeight }, [bitmap]);
    });
  }
};
