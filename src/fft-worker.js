/**
 * FFT Web Worker - processes FFT frames in parallel.
 * Receives: { type: 'compute', frames: [{data, window}], fftSize }
 * Returns: { type: 'result', magnitudes: [Float32Array] }
 */

self.onmessage = function(e) {
  const { type, tasks, fftSize } = e.data;

  if (type === 'compute') {
    const results = [];
    for (const task of tasks) {
      const { data, windowFunc } = task;
      const N = fftSize;
      const freqBins = N / 2;

      // Apply window
      const windowed = new Float32Array(N);
      for (let j = 0; j < N; j++) {
        windowed[j] = (data[j] || 0) * windowFunc[j];
      }

      // FFT
      const spectrum = fft(windowed, N);

      // Compute magnitudes in dB
      const magnitudes = new Float32Array(freqBins);
      for (let j = 0; j < freqBins; j++) {
        const re = spectrum[2 * j];
        const im = spectrum[2 * j + 1];
        const mag = Math.sqrt(re * re + im * im);
        const db = 20 * Math.log10(Math.max(mag, 1e-10));
        magnitudes[j] = isFinite(db) ? db : -120;
      }
      results.push(magnitudes);
    }

    self.postMessage({ type: 'result', magnitudes: results });
  }
};

function fft(input, N) {
  const logN = Math.log2(N);
  const output = new Float32Array(2 * N);

  // Bit-reversal permutation
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, logN);
    output[2 * j] = input[i];
  }

  // Butterfly stages
  for (let s = 1; s <= logN; s++) {
    const m = 1 << s;
    const halfM = m >> 1;
    const wRe = Math.cos(-2 * Math.PI / m);
    const wIm = Math.sin(-2 * Math.PI / m);

    for (let k = 0; k < N; k += m) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfM; j++) {
        const idx1 = 2 * (k + j);
        const idx2 = 2 * (k + j + halfM);
        const tRe = curRe * output[idx2] - curIm * output[idx2 + 1];
        const tIm = curRe * output[idx2 + 1] + curIm * output[idx2];

        output[idx2] = output[idx1] - tRe;
        output[idx2 + 1] = output[idx1 + 1] - tIm;
        output[idx1] += tRe;
        output[idx1 + 1] += tIm;

        const newRe = curRe * wRe - curIm * wIm;
        const newIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
        curIm = newIm;
      }
    }
  }

  return output;
}

function bitReverse(x, bits) {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (x & 1);
    x >>= 1;
  }
  return result;
}
