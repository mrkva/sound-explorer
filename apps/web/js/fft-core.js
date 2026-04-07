/**
 * Shared FFT core — Cooley-Tukey radix-2 with pre-computed twiddle factors
 * and bit-reversal tables. Used by both desktop and web FFT workers.
 */

// ── Lookup-table caches (keyed by N) ──────────────────────────────────────
const twiddleCache = new Map();
const bitRevCache = new Map();
const hannCache = new Map();

export function getTwiddle(N) {
  let t = twiddleCache.get(N);
  if (t) return t;
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

export function getBitRev(N) {
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

export function getHann(N) {
  let w = hannCache.get(N);
  if (w) return w;
  w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  }
  hannCache.set(N, w);
  return w;
}

/**
 * In-place radix-2 FFT. Returns interleaved complex array [re0, im0, re1, im1, ...].
 * @param {Float32Array|Float64Array} input - real-valued input of length N
 * @param {number} N - FFT size (must be power of 2)
 * @returns {Float32Array} interleaved complex output of length 2*N
 */
export function fft(input, N) {
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
    const step = N >> s;

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

/**
 * Extract magnitude in dB from interleaved complex FFT output.
 * @param {Float32Array} spectrum - interleaved complex array from fft()
 * @param {number} N - FFT size
 * @returns {Float32Array} magnitude in dB for the first N/2 bins
 */
export function magnitudesDB(spectrum, N) {
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
