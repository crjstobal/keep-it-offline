// Generates .cube LUTs used by the image pipeline.
// Run: node tools/gen-lut.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'luts');
const SIZE = 17; // 17^3 = 4913 entries, the common size for .cube files

// Rec. 709 luma coefficients: how the eye actually weighs each channel.
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

function buildCube(title, mapFn, size = SIZE) {
  const lines = [
    `TITLE "${title}"`,
    `LUT_3D_SIZE ${size}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
    '',
  ];
  // .cube iterates red fastest, then green, then blue.
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = mapFn(r / (size - 1), g / (size - 1), b / (size - 1));
        lines.push(out.map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '));
      }
    }
  }
  return lines.join('\n') + '\n';
}

// Black and white: luma-weighted desaturation with a gentle S-curve so the
// result has contrast instead of looking flat and grey.
function blackAndWhite(r, g, b) {
  const y = LUMA.r * r + LUMA.g * g + LUMA.b * b;
  const contrast = y * y * (3 - 2 * y); // smoothstep
  const v = y + (contrast - y) * 0.45;
  return [v, v, v];
}

// Teal and orange: the standard cinema grade. Shadows lean cyan, highlights
// lean warm, which is why it reads as "filmic" on almost any footage.
function tealAndOrange(r, g, b) {
  const y = LUMA.r * r + LUMA.g * g + LUMA.b * b;
  const split = (y - 0.5) * 2; // -1 in the shadows, +1 in the highlights
  const warm = Math.max(0, split);
  const cool = Math.max(0, -split);
  return [
    r + warm * 0.16 - cool * 0.06,
    g + warm * 0.05 + cool * 0.02,
    b - warm * 0.12 + cool * 0.16,
  ];
}

// Warm: a straightforward golden cast, the look of late afternoon light.
function warm(r, g, b) {
  return [r * 1.09 + 0.02, g * 1.02 + 0.01, b * 0.9];
}

// Cool: the opposite, for overcast and interior shots that came out yellow.
function cool(r, g, b) {
  return [r * 0.92, g * 0.99, b * 1.1 + 0.02];
}

// Faded: lifted blacks and pulled highlights, the washed-out film look.
function faded(r, g, b) {
  const lift = 0.06;
  const squeeze = 0.88;
  return [lift + r * squeeze, lift + g * squeeze, lift + b * squeeze * 1.02];
}

const PRESETS = [
  ['black-and-white', 'Black and White', blackAndWhite],
  ['teal-and-orange', 'Teal and Orange', tealAndOrange],
  ['warm', 'Warm', warm],
  ['cool', 'Cool', cool],
  ['faded', 'Faded', faded],
];

mkdirSync(OUT, { recursive: true });
for (const [slug, title, fn] of PRESETS) {
  writeFileSync(join(OUT, `${slug}.cube`), buildCube(title, fn));
  console.log(`wrote ${slug}.cube`);
}
