/**
 * FFT Web Worker – desktop app protocol.
 * Core FFT algorithm imported from shared lib.
 *
 * Protocols:
 *   { type: 'compute', tasks: [{data, windowFunc}], fftSize }
 *     -> { type: 'result', magnitudes: [Float32Array] }
 *
 *   { type: 'computeBulk', pcm: Float32Array, fftSize, hopSize, windowFunc }
 *     -> { type: 'bulkResult', magnitudes: [Float32Array] }
 *       (magnitudes ArrayBuffers are transferred, not copied)
 */

import { fft, magnitudesDB } from '../../../lib/fft-core.js';

self.onmessage = function(e) {
  const { type } = e.data;

  if (type === 'compute') {
    const { tasks, fftSize } = e.data;
    const results = [];
    for (const task of tasks) {
      const { data, windowFunc } = task;
      const N = fftSize;
      const windowed = new Float32Array(N);
      for (let j = 0; j < N; j++) {
        windowed[j] = (data[j] || 0) * windowFunc[j];
      }
      results.push(magnitudesDB(fft(windowed, N), N));
    }
    self.postMessage({ type: 'result', magnitudes: results });
  }

  else if (type === 'computeBulk') {
    const { pcm, fftSize, hopSize, windowFunc, startFrame, numFrames } = e.data;
    const N = fftSize;
    const results = new Array(numFrames);
    const windowed = new Float32Array(N);
    const transferList = [];

    for (let i = 0; i < numFrames; i++) {
      const off = (startFrame + i) * hopSize;
      for (let j = 0; j < N; j++) {
        windowed[j] = (pcm[off + j] || 0) * windowFunc[j];
      }
      const mag = magnitudesDB(fft(windowed, N), N);
      results[i] = mag;
      transferList.push(mag.buffer);
    }

    self.postMessage(
      { type: 'bulkResult', magnitudes: results },
      transferList
    );
  }
};
