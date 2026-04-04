/**
 * FFT Web Worker – optimised with pre-computed twiddle factors and
 * bit-reversal tables.  Caches tables per FFT size so they're built once.
 *
 * Protocols:
 *   { type: 'compute', tasks: [{data, windowFunc}], fftSize }
 *     → { type: 'result', magnitudes: [Float32Array] }
 *
 *   { type: 'computeBulk', pcm: Float32Array, fftSize, hopSize, windowFunc }
 *     → { type: 'bulkResult', magnitudes: [Float32Array] }
 *       (magnitudes ArrayBuffers are transferred, not copied)
 */

// ── Lookup-table caches (keyed by N) ──────────────────────────────────────
const twiddleCache = new Map();   // N → { re: Float64Array, im: Float64Array }
const bitRevCache  = new Map();   // N → Uint32Array

function getTwiddle(N) {
  let t = twiddleCache.get(N);
  if (t) return t;
  // Pre-compute all twiddle factors for every butterfly stage
  const re = new Float64Array(N / 2);
  const im = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    const angle = -2 * Math.PI * i / N;
    re[i] = Math.cos(angle);
    im[i] = Math.sin(angle);
  }
  t = { re, im };
  twiddleCache.set(N, t);
  return t;
}

function getBitRev(N) {
  let table = bitRevCache.get(N);
  if (table) return table;
  const logN = Math.log2(N) | 0;
  table = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let x = i, result = 0;
    for (let b = 0; b < logN; b++) {
      result = (result << 1) | (x & 1);
      x >>= 1;
    }
    table[i] = result;
  }
  bitRevCache.set(N, table);
  return table;
}

// ── Optimised in-place FFT ────────────────────────────────────────────────
function fft(input, N) {
  const logN = Math.log2(N) | 0;
  const bitRev = getBitRev(N);
  const tw = getTwiddle(N);
  const out = new Float32Array(2 * N);

  // Bit-reversal permutation
  for (let i = 0; i < N; i++) {
    out[2 * bitRev[i]] = input[i];
  }

  // Butterfly stages
  for (let s = 1; s <= logN; s++) {
    const m = 1 << s;
    const halfM = m >> 1;
    const step = N >> s;          // twiddle stride = N / m

    for (let k = 0; k < N; k += m) {
      for (let j = 0; j < halfM; j++) {
        const twIdx = j * step;
        const wRe = tw.re[twIdx];
        const wIm = tw.im[twIdx];

        const idx1 = 2 * (k + j);
        const idx2 = 2 * (k + j + halfM);

        const tRe = wRe * out[idx2] - wIm * out[idx2 + 1];
        const tIm = wRe * out[idx2 + 1] + wIm * out[idx2];

        out[idx2]     = out[idx1]     - tRe;
        out[idx2 + 1] = out[idx1 + 1] - tIm;
        out[idx1]     += tRe;
        out[idx1 + 1] += tIm;
      }
    }
  }
  return out;
}

// ── Magnitude extraction (shared) ─────────────────────────────────────────
function magnitudesDB(spectrum, N) {
  const freqBins = N / 2;
  const mag = new Float32Array(freqBins);
  for (let j = 0; j < freqBins; j++) {
    const re = spectrum[2 * j];
    const im = spectrum[2 * j + 1];
    const m = Math.sqrt(re * re + im * im);
    const db = 20 * Math.log10(Math.max(m, 1e-10));
    mag[j] = isFinite(db) ? db : -120;
  }
  return mag;
}

// ── Message handler ───────────────────────────────────────────────────────
self.onmessage = function(e) {
  const { type } = e.data;

  if (type === 'compute') {
    // Legacy per-task protocol (used by subsampled path)
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
    // Bulk protocol: worker windows + FFTs a contiguous PCM slice
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
