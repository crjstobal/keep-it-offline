import { readFileSync } from 'node:fs';
import { parseCube, sampleLut, applyLut } from './lut-logic.mjs';

let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (extra ? '\n       ' + extra : ''))); };

const text = readFileSync(new URL('../assets/luts/black-and-white.cube', import.meta.url), 'utf8');
const lut = parseCube(text);
check('parses the shipped LUT', lut.size === 17 && lut.table.length === 17**3 * 3,
      'size=' + lut.size + ' entries=' + lut.table.length / 3);

// A black-and-white LUT must return equal channels for any input.
const samples = [[0,0,0],[1,1,1],[1,0,0],[0,1,0],[0,0,1],[0.5,0.25,0.75],[0.9,0.1,0.4]];
let allGrey = true, detail = '';
for (const [r,g,b] of samples) {
  const [nr,ng,nb] = sampleLut(lut, r, g, b);
  if (Math.abs(nr-ng) > 0.01 || Math.abs(ng-nb) > 0.01) { allGrey = false; detail = `(${r},${g},${b}) -> (${nr.toFixed(3)},${ng.toFixed(3)},${nb.toFixed(3)})`; }
}
check('black-and-white LUT returns neutral greys', allGrey, detail);

// Black stays black, white stays white.
const black = sampleLut(lut, 0, 0, 0), white = sampleLut(lut, 1, 1, 1);
check('black maps to black', black[0] < 0.01, String(black));
check('white maps to white', white[0] > 0.99, String(white));

// Luma weighting: green must read brighter than blue at the same value.
const green = sampleLut(lut, 0, 1, 0)[0], blue = sampleLut(lut, 0, 0, 1)[0];
check('green is brighter than blue (luma weighted)', green > blue,
      'green=' + green.toFixed(3) + ' blue=' + blue.toFixed(3));

// Monotonic: brighter input never yields a darker result.
let monotonic = true;
let prev = -1;
for (let i = 0; i <= 20; i++) {
  const v = i / 20;
  const out = sampleLut(lut, v, v, v)[0];
  if (out < prev - 0.001) monotonic = false;
  prev = out;
}
check('greyscale ramp is monotonic', monotonic);

// Intensity blending.
const pixel = new Uint8ClampedArray([200, 50, 50, 255]);
const full = pixel.slice(); applyLut(full, lut, 1);
const half = pixel.slice(); applyLut(half, lut, 0.5);
const none = pixel.slice(); applyLut(none, lut, 0);
check('intensity 0 leaves the pixel unchanged', none[0] === 200 && none[1] === 50, String([...none]));
check('intensity 1 fully desaturates', Math.abs(full[0] - full[1]) <= 2, String([...full]));
check('intensity 0.5 lands between', half[0] > full[0] && half[0] < 200,
      'half=' + half[0] + ' full=' + full[0]);
check('alpha is preserved', full[3] === 255 && half[3] === 255);

// Out-of-range intensity must be clamped, not extrapolated.
const over = pixel.slice(); applyLut(over, lut, 5);
check('intensity above 1 is clamped', Math.abs(over[0] - full[0]) <= 1, 'over=' + over[0] + ' full=' + full[0]);

// Malformed input must be rejected rather than producing garbage.
let threw = false;
try { parseCube('LUT_3D_SIZE 4\n0 0 0\n1 1 1\n'); } catch { threw = true; }
check('truncated .cube is rejected', threw);

// A LUT with comments and blank lines still parses.
const withNoise = '# comment\n\nTITLE "x"\n' + text.split('\n').slice(1).join('\n');
let noisyOk = true;
try { parseCube(withNoise); } catch (e) { noisyOk = false; }
check('comments and blank lines are tolerated', noisyOk);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
