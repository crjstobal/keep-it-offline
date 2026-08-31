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

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'black-and-white.cube'), buildCube('Black and White', blackAndWhite));
console.log('wrote black-and-white.cube');
