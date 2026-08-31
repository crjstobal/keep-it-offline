import * as ws from '../src/core/workspace.js';

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log('  ok  ' + name)) : (fail++, console.log('  FAIL ' + name)); };

// Assets
const a = ws.addAsset({ name: 'doc.pdf', kind: 'pdf', bytes: new ArrayBuffer(8), meta: { pageCount: 10 } });
check('asset added', ws.listAssets().length === 1);
check('asset id prefixed by kind', a.id.startsWith('pdf_'));
check('loadedKinds tracks pdf', ws.loadedKinds().has('pdf'));

const img = ws.addAsset({ name: 'p.jpg', kind: 'image', bytes: new ArrayBuffer(4), meta: { width: 100, height: 50 } });
check('filter by kind', ws.listAssets('pdf').length === 1 && ws.listAssets('image').length === 1);

// Operations
const op1 = ws.pushOperation({ type: 'remove_pages', assetIds: a.id, params: { pages: [1,3] }, summary: 'Remove 2 pages', source: 'agent' });
const op2 = ws.pushOperation({ type: 'rotate_pages', assetIds: a.id, params: { pages: [0], degrees: 90 }, summary: 'Rotate', source: 'user' });
check('two ops queued', ws.operationsFor(a.id).length === 2);

ws.setOperationEnabled(op1.id, false);
check('disabled op excluded from operationsFor', ws.operationsFor(a.id).length === 1);
check('disabled op still visible in state', ws.getState().operations.length === 2);

ws.setOperationEnabled(op1.id, true);
check('re-enable works', ws.operationsFor(a.id).length === 2);

// Ordering
ws.moveOperation(op2.id, 0);
check('reorder works', ws.getState().operations[0].id === op2.id);

// Removing an asset must drop its operations
ws.removeAsset(a.id);
check('asset removed', ws.listAssets().length === 1);
check('orphan operations cleaned up', ws.getState().operations.length === 0);
check('loadedKinds updated after removal', !ws.loadedKinds().has('pdf') && ws.loadedKinds().has('image'));

// Subscriptions
let calls = 0;
const unsub = ws.subscribe(() => calls++);
ws.pushOperation({ type: 'x', assetIds: img.id, params: {}, summary: 's', source: 'user' });
check('subscriber notified', calls === 1);
unsub();
ws.clearOperations();
check('unsubscribe works', calls === 1);

// One operation covering several files is a single line in the stack, and one
// click to undo, rather than one entry per file.
const m1 = ws.addAsset({ name: 'a.jpg', kind: 'image', bytes: new ArrayBuffer(2), meta: {} });
const m2 = ws.addAsset({ name: 'b.jpg', kind: 'image', bytes: new ArrayBuffer(2), meta: {} });
const m3 = ws.addAsset({ name: 'c.jpg', kind: 'image', bytes: new ArrayBuffer(2), meta: {} });
ws.clearOperations();
const batch = ws.pushOperation({ type: 'apply_lut', assetIds: [m1.id, m2.id, m3.id], params: { lut_name: 'warm' }, summary: 'Apply warm to 3 images', source: 'user' });
check('a batch is one operation, not three', ws.getState().operations.length === 1);
check('the batch covers every file', [m1,m2,m3].every(a => ws.operationsFor(a.id).length === 1));

ws.setOperationEnabled(batch.id, false);
check('disabling the batch clears it from every file', [m1,m2,m3].every(a => ws.operationsFor(a.id).length === 0));
ws.setOperationEnabled(batch.id, true);

ws.removeAsset(m2.id);
check('removing one file keeps the batch for the others', ws.getState().operations.length === 1);
check('the removed file is dropped from the batch', batch.assetIds.length === 2 && !batch.assetIds.includes(m2.id));
ws.removeAsset(m1.id); ws.removeAsset(m3.id);
check('a batch covering nothing is discarded', ws.getState().operations.length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
