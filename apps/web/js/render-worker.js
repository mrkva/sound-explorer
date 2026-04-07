/**
 * Render Worker — web app protocol.
 * Converts FFT magnitude frames to ImageBitmap.
 * Colormap presets and LUT builder imported from shared lib.
 */

import { COLORMAPS, buildColorLUT } from './colormaps.js';

// Pre-build LUT cache for all colormaps
const lutCache = {};
for (const name of Object.keys(COLORMAPS)) {
  lutCache[name] = buildColorLUT(name);
}

self.onmessage = function(e) {
  const {
    magnitudes, numFrames, halfFFT,
    width, height,
    dbMin, dbMax,
    colormap,
    freqMin, freqMax, sampleRate, logScale,
    id
  } = e.data;

  const magData = new Float32Array(magnitudes);
  const lut = lutCache[colormap] || lutCache.viridis;
  const dbRange = dbMax - dbMin;

  // Pre-compute Y -> bin mapping
  const nyquist = sampleRate / 2;
  const freqToBin = (freq) => freq * halfFFT / nyquist;

  const yBins = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const frac = 1 - y / height;
    let freq;
    if (logScale && freqMin > 0) {
      const logMin = Math.log10(freqMin);
      const logMax = Math.log10(freqMax);
      freq = Math.pow(10, logMin + frac * (logMax - logMin));
    } else {
      freq = freqMin + frac * (freqMax - freqMin);
    }
    yBins[y] = freqToBin(freq);
  }

  // Render
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let x = 0; x < width; x++) {
    const frameIdx = Math.min(numFrames - 1, Math.floor(x * numFrames / width));
    const frameOffset = frameIdx * halfFFT;

    for (let y = 0; y < height; y++) {
      const bin = yBins[y];
      const binLow = Math.floor(bin);
      const binHigh = Math.min(binLow + 1, halfFFT - 1);
      const frac = bin - binLow;

      const val0 = magData[frameOffset + binLow] || -100;
      const val1 = magData[frameOffset + binHigh] || -100;
      const db = val0 + (val1 - val0) * frac;

      const norm = Math.max(0, Math.min(255, Math.round(((db - dbMin) / dbRange) * 255)));
      const lutIdx = norm * 4;
      const pixIdx = (y * width + x) * 4;
      pixels[pixIdx]     = lut[lutIdx];
      pixels[pixIdx + 1] = lut[lutIdx + 1];
      pixels[pixIdx + 2] = lut[lutIdx + 2];
      pixels[pixIdx + 3] = 255;
    }
  }

  const imgData = new ImageData(pixels, width, height);
  createImageBitmap(imgData).then(bitmap => {
    self.postMessage({ id, bitmap }, [bitmap]);
  });
};
