/**
 * Spectrogram render worker – desktop app protocol.
 * Colormap presets and LUT builder imported from shared lib.
 *
 * Receives: { type: 'render', frames, freqBins, numFrames, width, height,
 *             sampleRate, fftSize, minFreq, maxFreq, logFrequency,
 *             gainDB, dynamicRangeDB, colorPreset }
 * Returns:  { type: 'rendered', bitmap: ImageBitmap } (transferred)
 */

import { buildColorLUT } from './colormaps.js';

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

    // Y -> bin lookup (linear interpolation)
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
        if (raw0 === undefined || raw0 !== raw0) raw0 = -120;
        let raw;
        if (frac > 0 && bin0 + 1 <= maxBin) {
          let raw1 = spectrum[bin0 + 1];
          if (raw1 === undefined || raw1 !== raw1) raw1 = -120;
          raw = raw0 + frac * (raw1 - raw0);
        } else {
          raw = raw0;
        }

        const db = raw + gainDB;
        const lutIdx = Math.max(0, Math.min(255, Math.round((db - floor) * invRange))) | 0;

        const px = (y * spectWidth + x) * 4;
        const ci = lutIdx * 4;
        pixels[px]     = lut[ci];
        pixels[px + 1] = lut[ci + 1];
        pixels[px + 2] = lut[ci + 2];
        pixels[px + 3] = 255;
      }
    }

    const imageData = new ImageData(pixels, spectWidth, spectHeight);
    createImageBitmap(imageData).then(bitmap => {
      self.postMessage({ type: 'rendered', bitmap, width: spectWidth, height: spectHeight }, [bitmap]);
    });
  }
};
