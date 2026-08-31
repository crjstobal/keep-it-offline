export function parseCube(text) {
  let size = 0;
  const table = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    // TITLE and DOMAIN_MIN/MAX carry no information we need: the domain is
    // always 0-1 for the tables we ship.
    if (/^[A-Z_]+/.test(line)) continue;

    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      table.push(parts[0], parts[1], parts[2]);
    }
  }

  if (!size || table.length !== size * size * size * 3) {
    throw new Error(
      `Malformed .cube file: expected ${size ** 3} entries, found ${table.length / 3}`,
    );
  }
  return { size, table: Float32Array.from(table) };
}

/** Trilinear sample of the LUT. Values in and out are 0-1. */
export function sampleLut(lut, r, g, b) {
  const { size, table } = lut;
  const max = size - 1;

  const fr = r * max;
  const fg = g * max;
  const fb = b * max;

  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, max);
  const g1 = Math.min(g0 + 1, max);
  const b1 = Math.min(b0 + 1, max);

  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;

  // Red varies fastest, then green, then blue.
  const at = (ri, gi, bi) => (ri + gi * size + bi * size * size) * 3;

  let out0 = 0;
  let out1 = 0;
  let out2 = 0;

  for (let corner = 0; corner < 8; corner++) {
    const useR1 = corner & 1;
    const useG1 = corner & 2;
    const useB1 = corner & 4;

    const weight =
      (useR1 ? dr : 1 - dr) * (useG1 ? dg : 1 - dg) * (useB1 ? db : 1 - db);
    if (weight === 0) continue;

    const i = at(useR1 ? r1 : r0, useG1 ? g1 : g0, useB1 ? b1 : b0);
    out0 += table[i] * weight;
    out1 += table[i + 1] * weight;
    out2 += table[i + 2] * weight;
  }

  return [out0, out1, out2];
}

/**
 * Apply a LUT to pixel data in place.
 *
 * @param {Uint8ClampedArray} data  RGBA pixels.
 * @param {number} intensity        0 leaves the image alone, 1 applies fully.
 */
export function applyLut(data, lut, intensity = 1) {
  const amount = Math.min(1, Math.max(0, intensity));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const [nr, ng, nb] = sampleLut(lut, r, g, b);

    // Blending against the original is what makes intensity meaningful, and it
    // is why "a bit of this look" is expressible at all.
    data[i] = (r + (nr - r) * amount) * 255;
    data[i + 1] = (g + (ng - g) * amount) * 255;
    data[i + 2] = (b + (nb - b) * amount) * 255;
    // Alpha is left alone: grading should not change transparency.
  }
}

