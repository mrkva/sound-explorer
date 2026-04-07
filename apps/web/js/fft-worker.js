/**
 * FFT Web Worker — Cooley-Tukey radix-2 with pre-computed twiddle factors.
 * Receives PCM Float32Array slices, returns dB magnitude arrays.
 */

// Caches keyed by FFT size
const twiddleCache = new Map();
const bitRevCache = new Map();
const hannCache = new Map();

function getTwiddle(N) {
  if (twiddleCache.has(N)) return twiddleCache.get(N);
  const half = N / 2;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i++) {
    const angle = -2 * Math.PI * i / N;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  const t = { cos, sin };
  twiddleCache.set(N, t);
  return t;
}

function getBitRev(N) {
  if (bitRevCache.has(N)) return bitRevCache.get(N);
  const bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0, v = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (v & 1);
      v >>= 1;
    }
    rev[i] = r;
  }
  bitRevCache.set(N, rev);
  return rev;
}

function getHann(N) {
  if (hannCache.has(N)) return hannCache.get(N);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  }
  hannCache.set(N, w);
  return w;
}

function fft(real, imag, N) {
  const rev = getBitRev(N);
  const tw = getTwiddle(N);

  // Bit-reversal permutation
  const rOut = new Float64Array(N);
  const iOut = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    rOut[i] = real[rev[i]];
    iOut[i] = imag[rev[i]];
  }

  // Cooley-Tukey butterfly
  for (let size = 2; size <= N; size *= 2) {
    const halfSize = size / 2;
    const step = N / size;
    for (let i = 0; i < N; i += size) {
      for (let j = 0; j < halfSize; j++) {
        const twIdx = j * step;
        const tr = tw.cos[twIdx] * rOut[i + j + halfSize] - tw.sin[twIdx] * iOut[i + j + halfSize];
        const ti = tw.cos[twIdx] * iOut[i + j + halfSize] + tw.sin[twIdx] * rOut[i + j + halfSize];
        rOut[i + j + halfSize] = rOut[i + j] - tr;
        iOut[i + j + halfSize] = iOut[i + j] - ti;
        rOut[i + j] += tr;
        iOut[i + j] += ti;
      }
    }
  }

  return { real: rOut, imag: iOut };
}

self.onmessage = function(e) {
  const { samples, fftSize, hopSize, id } = e.data;
  const pcm = new Float32Array(samples);
  const hann = getHann(fftSize);
  const halfFFT = fftSize / 2;

  const numFrames = Math.max(1, Math.floor((pcm.length - fftSize) / hopSize) + 1);
  // Pack all frames into a single Float32Array (numFrames * halfFFT)
  const magnitudes = new Float32Array(numFrames * halfFFT);

  const real = new Float64Array(fftSize);
  const imag = new Float64Array(fftSize);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;

    // Apply window
    for (let i = 0; i < fftSize; i++) {
      const idx = start + i;
      real[i] = idx < pcm.length ? pcm[idx] * hann[i] : 0;
      imag[i] = 0;
    }

    const result = fft(real, imag, fftSize);

    // Compute magnitude in dB
    const outOffset = frame * halfFFT;
    for (let i = 0; i < halfFFT; i++) {
      const mag = Math.sqrt(result.real[i] * result.real[i] + result.imag[i] * result.imag[i]) / fftSize;
      magnitudes[outOffset + i] = 20 * Math.log10(Math.max(mag, 1e-10));
    }
  }

  self.postMessage({
    id,
    magnitudes: magnitudes.buffer,
    numFrames,
    halfFFT,
  }, [magnitudes.buffer]);
};
