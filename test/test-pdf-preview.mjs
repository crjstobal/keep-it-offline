import { PDFDocument } from 'pdf-lib';
import { applyOperations } from './worker-logic.mjs';
import { previewPages } from '../src/core/preview.js';

let pass = 0, fail = 0;
const check = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (extra ? '\n       ' + extra : ''))); };

const src = await PDFDocument.create();
for (let i = 0; i < 10; i++) src.addPage([595, 842]);
const bytes = await src.save();

const scenarios = [
  ['remove evens', [{type:'remove_pages', params:{pages:[1,3,5,7,9]}}]],
  ['remove first two', [{type:'remove_pages', params:{pages:[0,1]}}]],
  ['rotate one', [{type:'rotate_pages', params:{pages:[0], degrees:90}}]],
  ['rotate twice accumulates', [{type:'rotate_pages', params:{pages:[0], degrees:90}},{type:'rotate_pages', params:{pages:[0], degrees:90}}]],
  ['remove then rotate', [{type:'remove_pages', params:{pages:[0,1]}},{type:'rotate_pages', params:{pages:[0], degrees:270}}]],
  ['rotate then remove', [{type:'rotate_pages', params:{pages:[5], degrees:180}},{type:'remove_pages', params:{pages:[0]}}]],
  ['reorder reversed', [{type:'reorder_pages', params:{order:[9,8,7,6,5,4,3,2,1,0]}}]],
  ['reorder subset', [{type:'reorder_pages', params:{order:[3,1,0]}}]],
  ['chain of three', [{type:'remove_pages', params:{pages:[0]}},{type:'reorder_pages', params:{order:[2,1,0]}},{type:'rotate_pages', params:{pages:[1], degrees:90}}]],
  ['duplicate indices', [{type:'remove_pages', params:{pages:[1,1,1,3]}}]],
  ['out of range removal', [{type:'remove_pages', params:{pages:[99]}}]],
  ['unknown op ignored', [{type:'nonsense', params:{}}]],
  ['rotate then remove that page', [{type:'rotate_pages', params:{pages:[0], degrees:90}},{type:'remove_pages', params:{pages:[0]}}]],
];

for (const [name, ops] of scenarios) {
  const built = await applyOperations(bytes.slice(0), ops);
  const real = await PDFDocument.load(await built.save());
  const pred = previewPages(10, ops);
  const realRot = real.getPages().map(p => p.getRotation().angle);
  const predRot = pred.map(p => p.rotation);
  const ok = real.getPageCount() === pred.length && JSON.stringify(realRot) === JSON.stringify(predRot);
  check(name + ' -> ' + pred.length + ' pages', ok, 'real=[' + realRot + '] pred=[' + predRot + ']');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
