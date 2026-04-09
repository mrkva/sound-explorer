#!/usr/bin/env node
/**
 * Spectrogram self-test — validates the live rendering pipeline.
 *
 * Simulates the full path: test signal → window → FFT → magnitudesDB →
 * normalization → pixel mapping, then checks for visible artifacts in
 * frequency regions where the signal has no energy.
 *
 * Usage:  node apps/web/test-spectrogram.mjs
 */

import { getWindow, fft, magnitudesDB } from './js/fft-core.js';
import { buildColorLUT } from './js/colormaps.js';

// ── Configuration (mirrors live spectrogram defaults) ────────────────────

const SR = 48000;            // sample rate
const N  = 2048;             // FFT size
const WINDOW = 'blackman-harris';
const DB_MIN = -90;          // display floor (dBFS)
const DB_MAX = 0;            // display ceiling (dBFS)
const COLORMAP = 'viridis';

// ── Setup ────────────────────────────────────────────────────────────────

const win = getWindow(WINDOW, N);
let wSum = 0;
for (let i = 0; i < N; i++) wSum += win[i];
const normDB = 20 * Math.log10(wSum / 2);
const lut = buildColorLUT(COLORMAP);
const dbRange = DB_MAX - DB_MIN;

let totalTests = 0;
let passedTests = 0;

function assert(condition, msg) {
  totalTests++;
  if (condition) {
    passedTests++;
  } else {
    console.log(`  FAIL: ${msg}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Generate a windowed FFT magnitude array (dBFS) from a time-domain signal */
function computeSpectrum(signal) {
  const windowed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    windowed[i] = (i < signal.length ? signal[i] : 0) * win[i];
  }
  const raw = magnitudesDB(fft(windowed, N), N);
  // Normalize to dBFS
  const result = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    result[i] = raw[i] - normDB;
  }
  return result;
}

/** Map a dBFS value to pixel brightness [0..255] (same as _renderLiveFrame) */
function dBFStoPixel(dBFS) {
  return Math.max(0, Math.min(255, Math.round(((dBFS - DB_MIN) / dbRange) * 255)));
}

/** Check if a dBFS value would be visible (non-black) on screen */
function isVisible(dBFS) {
  return dBFStoPixel(dBFS) > 0;
}

/** Frequency (Hz) → FFT bin index */
function freqToBin(f) {
  return Math.round(f * N / SR);
}

/** FFT bin → frequency (Hz) */
function binToFreq(bin) {
  return bin * SR / N;
}

/** Max dBFS in a frequency range */
function maxInRange(spectrum, fLow, fHigh) {
  const bLow = Math.max(0, freqToBin(fLow));
  const bHigh = Math.min(N / 2 - 1, freqToBin(fHigh));
  let max = -Infinity;
  for (let j = bLow; j <= bHigh; j++) {
    if (spectrum[j] > max) max = spectrum[j];
  }
  return max;
}

/** Count visible bins in a frequency range */
function countVisible(spectrum, fLow, fHigh) {
  const bLow = Math.max(0, freqToBin(fLow));
  const bHigh = Math.min(N / 2 - 1, freqToBin(fHigh));
  let count = 0;
  for (let j = bLow; j <= bHigh; j++) {
    if (isVisible(spectrum[j])) count++;
  }
  return count;
}

// ── Test Signals ─────────────────────────────────────────────────────────

/** Pure sine wave filling entire window */
function makeSine(freqHz, amplitude = 1.0) {
  const sig = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    sig[i] = amplitude * Math.sin(2 * Math.PI * freqHz * i / SR);
  }
  return sig;
}

/** Sum-of-sines bandlimited to [fLow, fHigh] Hz */
function makeBandlimited(fLow, fHigh, amplitude = 0.18, numComponents = 100) {
  const sig = new Float32Array(N);
  for (let c = 0; c < numComponents; c++) {
    const f = fLow + (fHigh - fLow) * c / (numComponents - 1);
    const phase = Math.random() * 2 * Math.PI;
    const amp = amplitude / Math.sqrt(numComponents);
    for (let i = 0; i < N; i++) {
      sig[i] += amp * Math.sin(2 * Math.PI * f * i / SR + phase);
    }
  }
  return sig;
}

/** Bandlimited signal with onset at a given sample position */
function makeBandlimitedOnset(fLow, fHigh, onsetSample, riseSamples = 1, amplitude = 0.18) {
  const sig = new Float32Array(N);
  const numComponents = 80;
  for (let c = 0; c < numComponents; c++) {
    const f = fLow + (fHigh - fLow) * c / (numComponents - 1);
    const phase = Math.random() * 2 * Math.PI;
    const amp = amplitude / Math.sqrt(numComponents);
    for (let i = 0; i < N; i++) {
      let env = 0;
      if (i >= onsetSample + riseSamples) env = 1.0;
      else if (i >= onsetSample) env = (i - onsetSample) / riseSamples;
      sig[i] += amp * env * Math.sin(2 * Math.PI * f * i / SR + phase);
    }
  }
  return sig;
}

/** Silence */
function makeSilence() {
  return new Float32Array(N);
}

// ── Tests ────────────────────────────────────────────────────────────────

console.log(`\nSpectrogram Self-Test`);
console.log(`  FFT=${N}  Window=${WINDOW}  SR=${SR}  NormDB=${normDB.toFixed(1)}`);
console.log(`  Display: [${DB_MIN}, ${DB_MAX}] dBFS\n`);

// --- Test 1: Silence → all black ---
console.log('Test 1: Silence → all black');
{
  const sp = computeSpectrum(makeSilence());
  const vis = countVisible(sp, 0, SR / 2);
  assert(vis === 0, `${vis} visible bins in silence (expected 0)`);
  console.log(`  ${vis === 0 ? 'PASS' : 'FAIL'}: ${vis} visible bins`);
}

// --- Test 2: Pure tone → peak at correct bin, no visible sidelobes ---
console.log('\nTest 2: Pure 0 dBFS tone at 5kHz → correct peak, no sidelobes above 10kHz');
{
  const sp = computeSpectrum(makeSine(5000, 1.0));
  const peakBin = freqToBin(5000);
  const peakLevel = sp[peakBin];
  const sidelobes = maxInRange(sp, 10000, 24000);
  const visAbove10k = countVisible(sp, 10000, 24000);

  assert(Math.abs(peakLevel) < 1.0, `Peak at ${peakLevel.toFixed(1)} dBFS (expected ~0)`);
  assert(sidelobes < DB_MIN, `Max sidelobe above 10kHz: ${sidelobes.toFixed(1)} dBFS (should be < ${DB_MIN})`);
  assert(visAbove10k === 0, `${visAbove10k} visible bins above 10kHz (expected 0)`);

  console.log(`  Peak: ${peakLevel.toFixed(1)} dBFS`);
  console.log(`  Sidelobes >10kHz: ${sidelobes.toFixed(1)} dBFS → ${visAbove10k} visible bins`);
}

// --- Test 3: Steady broadband signal → visible in band, nothing above ---
console.log('\nTest 3: Steady broadband 500-8000 Hz at -15 dBFS → no artifacts above 12kHz');
{
  const sp = computeSpectrum(makeBandlimited(500, 8000, 0.18));
  const inBand = maxInRange(sp, 500, 8000);
  const above12k = maxInRange(sp, 12000, 24000);
  const visAbove12k = countVisible(sp, 12000, 24000);

  assert(inBand > DB_MIN, `In-band energy: ${inBand.toFixed(1)} dBFS (should be visible)`);
  assert(visAbove12k === 0, `${visAbove12k} visible bins above 12kHz (expected 0)`);

  console.log(`  In-band max: ${inBand.toFixed(1)} dBFS`);
  console.log(`  Above 12kHz: ${above12k.toFixed(1)} dBFS → ${visAbove12k} visible bins`);
}

// --- Test 4: Abrupt onset transient → check leakage at different rise times ---
console.log('\nTest 4: Onset transient (-15 dBFS, 500-8kHz) → leakage above 15kHz');
{
  const riseTimes = [1, 6, 24, 96, 480];
  for (const rise of riseTimes) {
    const sp = computeSpectrum(makeBandlimitedOnset(500, 8000, N / 2, rise, 0.18));
    const above15k = maxInRange(sp, 15000, 24000);
    const visAbove15k = countVisible(sp, 15000, 24000);
    const riseMs = (rise / SR * 1000).toFixed(2);
    const status = visAbove15k === 0 ? 'PASS' : `LEAK(${visAbove15k} bins)`;

    assert(visAbove15k === 0, `Rise ${rise} (${riseMs}ms): ${visAbove15k} visible bins above 15kHz`);
    console.log(`  Rise ${String(rise).padStart(3)} samples (${riseMs.padStart(5)}ms): >15kHz = ${above15k.toFixed(1).padStart(7)} dBFS  ${status}`);
  }
}

// --- Test 5: Loud transient (0 dBFS) → worst case leakage ---
console.log('\nTest 5: Loud onset (0 dBFS, 500-8kHz) → leakage above 15kHz');
{
  const riseTimes = [1, 6, 24, 96];
  for (const rise of riseTimes) {
    const sp = computeSpectrum(makeBandlimitedOnset(500, 8000, N / 2, rise, 1.0));
    const above10k = maxInRange(sp, 10000, 24000);
    const above15k = maxInRange(sp, 15000, 24000);
    const above20k = maxInRange(sp, 20000, 24000);
    const visAbove15k = countVisible(sp, 15000, 24000);
    const riseMs = (rise / SR * 1000).toFixed(2);

    assert(visAbove15k === 0, `Rise ${rise}: ${visAbove15k} visible bins above 15kHz at 0 dBFS`);
    console.log(`  Rise ${String(rise).padStart(3)} (${riseMs.padStart(5)}ms): >10k=${above10k.toFixed(1).padStart(7)}  >15k=${above15k.toFixed(1).padStart(7)}  >20k=${above20k.toFixed(1).padStart(7)} dBFS  vis=${visAbove15k}`);
  }
}

// --- Test 6: Normalization calibration ---
console.log('\nTest 6: Normalization calibration');
{
  // 0 dBFS sine should map to 0 dBFS after normalization
  const sp0 = computeSpectrum(makeSine(5000, 1.0));
  const peak0 = sp0[freqToBin(5000)];
  assert(Math.abs(peak0) < 0.5, `0 dBFS sine: peak=${peak0.toFixed(2)} dBFS (expected 0.0 ±0.5)`);

  // -20 dBFS sine should map to -20 dBFS
  const sp20 = computeSpectrum(makeSine(5000, 0.1));
  const peak20 = sp20[freqToBin(5000)];
  assert(Math.abs(peak20 + 20) < 0.5, `-20 dBFS sine: peak=${peak20.toFixed(2)} dBFS (expected -20.0 ±0.5)`);

  // -80 dBFS sine should be visible
  const sp80 = computeSpectrum(makeSine(5000, 0.0001));
  const peak80 = sp80[freqToBin(5000)];
  const vis80 = isVisible(peak80);
  assert(vis80, `-80 dBFS sine: peak=${peak80.toFixed(2)} dBFS, visible=${vis80}`);

  // -95 dBFS sine should NOT be visible (below -90 floor)
  const sp95 = computeSpectrum(makeSine(5000, 0.0000178));
  const peak95 = sp95[freqToBin(5000)];
  const vis95 = isVisible(peak95);
  assert(!vis95, `-95 dBFS sine: peak=${peak95.toFixed(2)} dBFS, visible=${vis95} (should be false)`);

  console.log(`  0 dBFS → ${peak0.toFixed(2)} dBFS  (pixel ${dBFStoPixel(peak0)})`);
  console.log(`  -20 dBFS → ${peak20.toFixed(2)} dBFS  (pixel ${dBFStoPixel(peak20)})`);
  console.log(`  -80 dBFS → ${peak80.toFixed(2)} dBFS  (pixel ${dBFStoPixel(peak80)})`);
  console.log(`  -95 dBFS → ${peak95.toFixed(2)} dBFS  (pixel ${dBFStoPixel(peak95)})`);
}

// --- Test 7: Pixel brightness sanity ---
console.log('\nTest 7: Pixel brightness mapping');
{
  assert(dBFStoPixel(0) === 255, `0 dBFS → pixel ${dBFStoPixel(0)} (expected 255)`);
  assert(dBFStoPixel(-45) === 128, `-45 dBFS → pixel ${dBFStoPixel(-45)} (expected 128)`);
  assert(dBFStoPixel(-90) === 0, `-90 dBFS → pixel ${dBFStoPixel(-90)} (expected 0)`);
  assert(dBFStoPixel(-100) === 0, `-100 dBFS → pixel ${dBFStoPixel(-100)} (expected 0)`);

  console.log(`  0 dBFS → ${dBFStoPixel(0)},  -45 → ${dBFStoPixel(-45)},  -90 → ${dBFStoPixel(-90)},  -100 → ${dBFStoPixel(-100)}`);
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passedTests}/${totalTests} passed`);
if (passedTests < totalTests) {
  console.log(`\n${totalTests - passedTests} test(s) FAILED — see details above.`);
  process.exit(1);
} else {
  console.log(`All tests passed.`);
}
