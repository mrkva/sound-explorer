/**
 * Render Worker — converts FFT magnitude frames to ImageBitmap.
 * Receives magnitude data + colormap LUT, returns rendered bitmap.
 */

// Colormap definitions (256-entry LUTs built on init)
const COLORMAPS = {
  viridis: [
    [0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140],
    [0.75, 94, 201, 98], [1, 253, 231, 37]
  ],
  magma: [
    [0, 0, 0, 4], [0.25, 81, 18, 124], [0.5, 183, 55, 121],
    [0.75, 252, 137, 97], [1, 252, 253, 191]
  ],
  inferno: [
    [0, 0, 0, 4], [0.25, 87, 16, 110], [0.5, 188, 55, 84],
    [0.75, 249, 142, 9], [1, 252, 255, 164]
  ],
  grayscale: [
    [0, 0, 0, 0], [1, 255, 255, 255]
  ],
  green: [
    [0, 0, 0, 0], [0.5, 0, 128, 0], [1, 0, 255, 0]
  ],
  hot: [
    [0, 0, 0, 0], [0.33, 200, 0, 0], [0.66, 255, 200, 0], [1, 255, 255, 255]
  ],
};

function buildLUT(stops) {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    // Find surrounding stops
    let s0 = stops[0], s1 = stops[stops.length - 1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) {
        s0 = stops[j];
        s1 = stops[j + 1];
        break;
      }
    }
    const range = s1[0] - s0[0];
    const f = range > 0 ? (t - s0[0]) / range : 0;
    lut[i * 4] = Math.round(s0[1] + (s1[1] - s0[1]) * f);
    lut[i * 4 + 1] = Math.round(s0[2] + (s1[2] - s0[2]) * f);
    lut[i * 4 + 2] = Math.round(s0[3] + (s1[3] - s0[3]) * f);
    lut[i * 4 + 3] = 255;
  }
  return lut;
}

const lutCache = {};
for (const [name, stops] of Object.entries(COLORMAPS)) {
  lutCache[name] = buildLUT(stops);
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
  const binToFreq = (bin) => bin * nyquist / halfFFT;
  const freqToBin = (freq) => freq * halfFFT / nyquist;

  const yBins = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const frac = 1 - y / height; // bottom=0, top=1
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
    // Map x to frame index
    const frameIdx = Math.min(numFrames - 1, Math.floor(x * numFrames / width));
    const frameOffset = frameIdx * halfFFT;

    for (let y = 0; y < height; y++) {
      const bin = yBins[y];
      const binLow = Math.floor(bin);
      const binHigh = Math.min(binLow + 1, halfFFT - 1);
      const frac = bin - binLow;

      // Linear interpolation between bins
      const val0 = magData[frameOffset + binLow] || -100;
      const val1 = magData[frameOffset + binHigh] || -100;
      const db = val0 + (val1 - val0) * frac;

      // Normalize to 0-255
      const norm = Math.max(0, Math.min(255, Math.round(((db - dbMin) / dbRange) * 255)));
      const lutIdx = norm * 4;
      const pixIdx = (y * width + x) * 4;
      pixels[pixIdx] = lut[lutIdx];
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
