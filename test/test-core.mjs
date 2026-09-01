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

// A live control owns one row and rewrites it, so dragging a slider through a
// dozen values leaves one change behind rather than a dozen.
ws.clearOperations();
const liveAsset = ws.addAsset({ name: 'x.jpg', kind: 'image', bytes: new ArrayBuffer(2), meta: {} });
const liveOp = ws.pushOperation({ type: 'adjust_image', assetIds: liveAsset.id, params: { brightness: 0.1 }, summary: 'brightness +10', source: 'user' });
ws.updateOperation(liveOp.id, { params: { brightness: 0.8 }, summary: 'brightness +80' });
check('updating an operation leaves one row', ws.getState().operations.length === 1);
check('the updated value is kept', ws.getState().operations[0].params.brightness === 0.8);
check('the summary follows the value', ws.getState().operations[0].summary === 'brightness +80');
check('updating merges rather than replacing params', ws.updateOperation(liveOp.id, { params: { contrast: 0.2 } }) && ws.getState().operations[0].params.brightness === 0.8 && ws.getState().operations[0].params.contrast === 0.2);
check('updating an operation that is gone reports failure', ws.updateOperation('op_missing', { summary: 'x' }) === false);
ws.removeAsset(liveAsset.id);

// Reordering addresses a gap between files, which is what a drop marker draws.
ws.clearOperations();
for (const a of [...ws.listAssets()]) ws.removeAsset(a.id);
const order = () => ws.listAssets().map(a => a.name).join(',');
const a1 = ws.addAsset({ name: 'a', kind: 'image', bytes: new ArrayBuffer(1), meta: {} });
const a2 = ws.addAsset({ name: 'b', kind: 'image', bytes: new ArrayBuffer(1), meta: {} });
const a3 = ws.addAsset({ name: 'c', kind: 'image', bytes: new ArrayBuffer(1), meta: {} });
check('files start in the order they arrived', order() === 'a,b,c', order());

ws.moveAssetToIndex(a3.id, 0);
check('moving to gap 0 puts a file first', order() === 'c,a,b', order());

ws.moveAssetToIndex(a3.id, 3);
check('moving to the last gap puts a file last', order() === 'a,b,c', order());

ws.moveAssetToIndex(a1.id, 2);
check('a move past itself accounts for the shift', order() === 'b,a,c', order());

check('moving to where it already is changes nothing',
      ws.moveAssetToIndex(a1.id, 1) === false && order() === 'b,a,c', order());
check('moving something that is gone reports failure',
      ws.moveAssetToIndex('image_missing', 0) === false);
for (const a of [a1, a2, a3]) ws.removeAsset(a.id);


// --- Kind-scoped operations ------------------------------------------------
// "Warm up the photographs" is a decision about the photographs, not about the
// ones that happened to be loaded when the slider moved. Files dropped later
// must arrive with it already applied.
const s1 = ws.addAsset({ name: 's1.jpg', kind: 'image', bytes: new ArrayBuffer(1), meta: {} });
const scoped = ws.pushOperation({
  type: 'apply_lut', scope: 'image', params: { lut_name: 'warm' },
  summary: 'Grade every photo', source: 'user',
});
check('a scoped op covers the file that was loaded', ws.operationsFor(s1.id).length === 1);

const s2 = ws.addAsset({ name: 's2.jpg', kind: 'image', bytes: new ArrayBuffer(1), meta: {} });
check('a scoped op covers a file added afterwards', ws.operationsFor(s2.id).length === 1);

const other = ws.addAsset({ name: 'v.mp4', kind: 'video', bytes: new ArrayBuffer(1), meta: {} });
check('a scoped op does not leak to another kind', ws.operationsFor(other.id).length === 0);

const pinned = ws.pushOperation({
  type: 'trim_video', assetIds: [other.id], params: { start: 0, end: 1 },
  summary: 'Trim', source: 'user',
});
const s3 = ws.addAsset({ name: 'v2.mp4', kind: 'video', bytes: new ArrayBuffer(1), meta: {} });
check('a pinned op stays on its own file', ws.operationsFor(s3.id).length === 0);

ws.setOperationEnabled(scoped.id, false);
check('unticking a scoped op releases every file', ws.operationsFor(s2.id).length === 0);
ws.setOperationEnabled(scoped.id, true);

// Removing one photo must not take the whole grade with it.
ws.removeAsset(s1.id);
check('a scoped op survives one of its files going',
      ws.getState().operations.some((o) => o.id === scoped.id));
check('the remaining photo is still covered', ws.operationsFor(s2.id).length === 1);

// When the last photo goes there is nothing left for it to cover.
ws.removeAsset(s2.id);
check('a scoped op goes when the last file of its kind goes',
      !ws.getState().operations.some((o) => o.id === scoped.id));
check('the pinned video op is untouched by that',
      ws.getState().operations.some((o) => o.id === pinned.id));
for (const a of [other, s3]) ws.removeAsset(a.id);
check('operationsFor is empty for a file that is gone', ws.operationsFor(s1.id).length === 0);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
