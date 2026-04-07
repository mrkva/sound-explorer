/**
 * Shared colormap presets and LUT builder for spectrogram rendering.
 * Used by both desktop and web render workers.
 */

export const COLORMAPS = {
  viridis: [
    [0.0, 68, 1, 84], [0.13, 72, 36, 117], [0.25, 65, 68, 135],
    [0.38, 53, 95, 141], [0.50, 42, 120, 142], [0.63, 33, 145, 140],
    [0.75, 34, 168, 132], [0.82, 68, 191, 112], [0.88, 122, 209, 81],
    [0.94, 189, 223, 38], [1.0, 253, 231, 37]
  ],
  magma: [
    [0.0, 0, 0, 4], [0.13, 28, 16, 68], [0.25, 79, 18, 123],
    [0.38, 129, 37, 129], [0.50, 181, 54, 122], [0.63, 229, 89, 100],
    [0.75, 251, 136, 97], [0.85, 254, 188, 118], [0.94, 254, 228, 152],
    [1.0, 252, 253, 191]
  ],
  inferno: [
    [0.0, 0, 0, 4], [0.13, 31, 12, 72], [0.25, 85, 15, 109],
    [0.38, 136, 34, 106], [0.50, 186, 54, 85], [0.63, 227, 89, 51],
    [0.75, 249, 140, 10], [0.85, 249, 201, 50], [0.94, 240, 249, 33],
    [1.0, 252, 255, 164]
  ],
  grayscale: [
    [0.0, 0, 0, 0], [1.0, 255, 255, 255]
  ],
  green: [
    [0.0, 0, 0, 0], [0.25, 0, 30, 0], [0.5, 0, 100, 10],
    [0.75, 30, 200, 30], [1.0, 180, 255, 100]
  ],
  hot: [
    [0.0, 0, 0, 0], [0.33, 180, 0, 0], [0.66, 255, 200, 0],
    [1.0, 255, 255, 255]
  ]
};

/**
 * Build a 256-entry RGBA color lookup table from a colormap preset.
 * @param {string} presetName - key from COLORMAPS
 * @returns {Uint8Array} 256*4 bytes (RGBA)
 */
export function buildColorLUT(presetName) {
  const stops = COLORMAPS[presetName] || COLORMAPS.viridis;
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const value = i / 255;
    let r = 0, g = 0, b = 0;
    for (let s = 0; s < stops.length - 1; s++) {
      if (value <= stops[s + 1][0]) {
        const t = (value - stops[s][0]) / (stops[s + 1][0] - stops[s][0]);
        r = Math.round(stops[s][1] + t * (stops[s + 1][1] - stops[s][1]));
        g = Math.round(stops[s][2] + t * (stops[s + 1][2] - stops[s][2]));
        b = Math.round(stops[s][3] + t * (stops[s + 1][3] - stops[s][3]));
        break;
      }
      if (s === stops.length - 2) {
        const last = stops[stops.length - 1];
        r = last[1]; g = last[2]; b = last[3];
      }
    }
    lut[i * 4]     = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
