/**
 * FFT Web Worker — web app protocol.
 * Core FFT algorithm imported from shared lib.
 * Receives PCM Float32Array slices, returns packed dB magnitude array.
 */

import { getHann, fft, magnitudesDB } from '../../../lib/fft-core.js';

self.onmessage = function(e) {
  const { samples, fftSize, hopSize, id } = e.data;
  const pcm = new Float32Array(samples);
  const hann = getHann(fftSize);
  const halfFFT = fftSize / 2;

  const numFrames = Math.max(1, Math.floor((pcm.length - fftSize) / hopSize) + 1);
  const magnitudes = new Float32Array(numFrames * halfFFT);

  const windowed = new Float32Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;

    // Apply window
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      windowed[i] = idx < pcm.length ? pcm[idx] * hann[i] : 0;
    }

    const spectrum = fft(windowed, fftSize);
    // Normalize FFT output (web app dB range assumes normalized magnitudes)
    for (let i = 0; i < spectrum.length; i++) spectrum[i] /= fftSize;
    const mag = magnitudesDB(spectrum, fftSize);

    // Copy into packed output
    const outOffset = frame * halfFFT;
    magnitudes.set(mag, outOffset);
  }

  self.postMessage({
    id,
    magnitudes: magnitudes.buffer,
    numFrames,
    halfFFT,
  }, [magnitudes.buffer]);
};
