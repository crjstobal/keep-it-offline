import { readFileSync } from 'node:fs';
import { parseCube, sampleLut } from './lut-logic.mjs';

let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (extra ? ' :: ' + extra : ''))); };

const names = ['black-and-white','teal-and-orange','warm','cool','faded'];
for (const name of names) {
  const lut = parseCube(readFileSync(new URL('../assets/luts/' + name + '.cube', import.meta.url), 'utf8'));
  check(name + ': parses', lut.size === 17);

  // Every entry must be inside the valid colour range, or exports clip badly.
  let inRange = true;
  for (const v of lut.table) if (v < -0.001 || v > 1.001) { inRange = false; break; }
  check(name + ': all values within 0-1', inRange);

  // A LUT that crushes everything to one value would be useless.
  const ramp = [0, 0.25, 0.5, 0.75, 1].map(v => sampleLut(lut, v, v, v)[0]);
  const spread = Math.max(...ramp) - Math.min(...ramp);
  check(name + ': preserves tonal range', spread > 0.5, 'spread=' + spread.toFixed(2));

  // Neutral input should stay reasonably neutral except where a look is meant
  // to tint: check it does not swing wildly.
  const mid = sampleLut(lut, 0.5, 0.5, 0.5);
  const swing = Math.max(...mid) - Math.min(...mid);
  check(name + ': mid grey does not swing wildly', swing < 0.25, 'swing=' + swing.toFixed(3));
}

// The colour looks must actually differ from each other.
const graded = names.map(n => {
  const lut = parseCube(readFileSync(new URL('../assets/luts/' + n + '.cube', import.meta.url), 'utf8'));
  return sampleLut(lut, 0.8, 0.4, 0.2).map(v => v.toFixed(3)).join(',');
});
check('all five looks produce distinct results', new Set(graded).size === 5, graded.join(' | '));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
