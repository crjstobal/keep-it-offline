// Entry point. The app is fully usable with no agent attached: WebMCP only ever
// adds a second way to drive the same state.

import {
  addAsset,
  isJoinProduct,
  clearOperations,
  clearSelection,
  getAsset,
  getState,
  listAssets,
  operationsFor,
  removeAsset,
  removeOperation,
  pushOperation,
  selectedAssets,
  setOperationEnabled,
  setSelection,
  subscribe,
  touch,
} from './core/workspace.js';
import { previewPages } from './core/preview.js';
import { isSupported, onRegistryChange, start } from './core/registry.js';
import { imageCall, pdfCall } from './core/worker-bridge.js';
import { ensureLutLoaded, lutFor } from './core/luts.js';
import { applyLutToPixels } from './core/lut-math.js';
import * as video from './core/video.js';
import * as audio from './core/audio.js';
import * as grid from './ui/page-grid.js';
import * as imagePanel from './ui/image-panel.js';
import * as videoPanel from './ui/video-panel.js';
import * as audioPanel from './ui/audio-panel.js';
import * as demoLoader from './ui/demo-loader.js';

import './tools/workspace-tools.js';
import './tools/pdf-tools.js';
import './tools/image-tools.js';
import './tools/video-tools.js';
import './tools/audio-tools.js';

const els = {
  dropzone: document.getElementById('dropzone'),
  fileInput: document.getElementById('file-input'),
  assetList: document.getElementById('asset-list'),
  opList: document.getElementById('op-list'),
  toolList: document.getElementById('tool-list'),
  toolsHint: document.getElementById('tools-hint'),
  exportBtn: document.getElementById('export-btn'),
  agentStatus: document.getElementById('agent-status'),
  agentStatusText: document.getElementById('agent-status-text'),
  editor: document.getElementById('editor'),
  gridHost: document.getElementById('page-grid-host'),
  selectionCount: document.getElementById('selection-count'),
  rotateLeft: document.getElementById('rotate-left'),
  rotateRight: document.getElementById('rotate-right'),
  removeSelected: document.getElementById('remove-selected'),
  imageEditor: document.getElementById('image-editor'),
  videoEditor: document.getElementById('video-editor'),
  audioEditor: document.getElementById('audio-editor'),
};

audioPanel.init({
  list: document.getElementById('audio-list'),
  speed: document.getElementById('audio-speed'),
  speedValue: document.getElementById('audio-speed-value'),
});

videoPanel.init({
  grid: document.getElementById('video-grid'),
  look: document.getElementById('video-look'),
  rotateLeft: document.getElementById('video-rotate-left'),
  rotateRight: document.getElementById('video-rotate-right'),
  strength: document.getElementById('video-strength'),
  strengthValue: document.getElementById('video-strength-value'),
});

imagePanel.init({
  grid: document.getElementById('image-grid'),
  lookSelect: document.getElementById('look-select'),
  lookStrength: document.getElementById('look-strength'),
  lookStrengthValue: document.getElementById('look-strength-value'),
  resizeWidth: document.getElementById('resize-width'),
  formatSelect: document.getElementById('format-select'),
  rotateLeft: document.getElementById('image-rotate-left'),
  rotateRight: document.getElementById('image-rotate-right'),
  orientation: document.getElementById('image-orientation'),
  brightness: document.getElementById('adj-brightness'),
  contrast: document.getElementById('adj-contrast'),
  saturation: document.getElementById('adj-saturation'),
  vibrance: document.getElementById('adj-vibrance'),
  resetAdjust: document.getElementById('reset-adjust'),
  vignette: document.getElementById('adj-vignette'),
  watermarkText: document.getElementById('watermark-text'),
  watermarkPosition: document.getElementById('watermark-position'),
  maskShape: document.getElementById('mask-shape'),
  maskSize: document.getElementById('mask-size'),
  maskX: document.getElementById('mask-x'),
  maskY: document.getElementById('mask-y'),
  maskBorder: document.getElementById('mask-border'),
  maskBorderColor: document.getElementById('mask-border-color'),
  reshuffleBlob: document.getElementById('reshuffle-blob'),
});

// --- Manual editing --------------------------------------------------------
// Everything here is available with no agent attached. The tools and these
// buttons push identical operations onto the same stack.

grid.init({
  container: els.gridHost,
  onSelectionChange: (count) => {
    els.selectionCount.textContent =
      count === 0 ? 'No pages selected' : `${count} page${count === 1 ? '' : 's'} selected`;
    for (const button of [els.rotateLeft, els.rotateRight, els.removeSelected]) {
      button.disabled = count === 0;
    }
  },
});

for (const button of document.querySelectorAll('[data-select]')) {
  button.addEventListener('click', () => {
    const mode = button.dataset.select;
    mode === 'none'
      ? grid.clearSelection(els.gridHost)
      : grid.selectPages(els.gridHost, mode);
  });
}

// One control sizes each grid, so a long document can be scanned at a glance or
// inspected closely without leaving the page.
// Each grid has its own size control, since a contact sheet of photographs and
// a row of video players want very different defaults.
for (const [id, apply] of [
  ['thumb-size', (value) => els.gridHost.style.setProperty('--thumb-size', `${value}px`)],
  ['image-thumb-size', (value) => imagePanel.setThumbSize(value)],
  ['video-thumb-size', (value) => videoPanel.setThumbSize(value)],
]) {
  const slider = document.getElementById(id);
  const readout = document.getElementById(`${id}-value`);
  const base = Number(slider.value);

  // The readout is relative to where the slider starts, because a percentage of
  // the default size means something to a person and a pixel width does not.
  const update = () => {
    const value = Number(slider.value);
    apply(value);
    if (readout) readout.textContent = `${Math.round((value / base) * 100)}%`;
  };
  slider.addEventListener('input', update);
  update();
}

els.removeSelected.addEventListener('click', () => grid.removeSelected(els.gridHost));

// Three retreats of increasing size, kept apart on purpose. Undo takes back the
// last change; Undo all keeps the files and drops every edit; Start over clears
// the bench entirely.
//
// This one does not ask. A confirmation on an undo is a dialog standing between
// somebody and the thing that was going to reassure them, and it costs nothing
// to get wrong: the step is still on the stack to tick back on.
function undoLast() {
  const ops = getState().operations;
  if (ops.length === 0) return;
  removeOperation(ops[ops.length - 1].id);
}

document.getElementById('undo-last').addEventListener('click', undoLast);

// A button labelled Undo has to answer to the shortcut, or the label is a lie.
// Typing in a field is left alone: there the browser's own undo is the right one.
window.addEventListener('keydown', (event) => {
  if (event.key !== 'z' || !(event.metaKey || event.ctrlKey) || event.shiftKey) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
  event.preventDefault();
  undoLast();
});
document.getElementById('clear-changes').addEventListener('click', () => {
  const count = getState().operations.length;
  if (!count) return;
  if (window.confirm(`Undo all ${count} change${count === 1 ? '' : 's'}? Your files stay where they are.`)) {
    clearOperations();
  }
});

document.getElementById('start-over').addEventListener('click', () => {
  const state = getState();
  const onBench = listAssets();
  if (onBench.length === 0) return;
  const files = onBench.length;
  const changes = state.operations.length;
  const detail = changes
    ? `${files} file${files === 1 ? '' : 's'} and ${changes} change${changes === 1 ? '' : 's'}`
    : `${files} file${files === 1 ? '' : 's'}`;
  if (window.confirm(`Start over? This clears ${detail} from the bench.`)) {
    clearOperations();
    // The raw list, not the bench: a document hidden behind a join is still
    // loaded, and starting over has to clear it as well.
    for (const asset of [...state.assets]) removeAsset(asset.id);
  }
});

document.getElementById('remove-blank').addEventListener('click', async () => {
  // Same rule as blacking out: with several documents loaded, the one the user
  // means has to be the one they picked.
  const pdf = grid.getCurrentAsset();
  if (!pdf) {
    if (listAssets('pdf').length > 1) {
      window.alert('Several documents are loaded. Tick a page of the one you mean first.');
    }
    return;
  }
  const { findBlankPages } = await import('./core/redact.js');
  const { blank, pageCount } = await findBlankPages(pdf.bytes);

  if (blank.length === 0) {
    window.alert('No blank pages found.');
    return;
  }
  if (blank.length === pageCount) {
    window.alert('Every page is blank, and a PDF has to keep at least one.');
    return;
  }
  pushOperation({
    type: 'remove_pages',
    assetIds: pdf.id,
    params: { pages: blank.map((n) => n - 1) },
    summary: `Remove ${blank.length} blank page${blank.length === 1 ? '' : 's'}: ${blank.join(', ')}`,
    source: 'user',
  });
});
// --- Blacking out by hand --------------------------------------------------
// The same operation the agent's redact_pdf tool pushes, driven by a person.
// Both paths call findMatches and rasterisePages and end at pushOperation, so a
// redaction has one meaning whoever asked for it.

const blackout = {
  panel: document.getElementById('black-out-panel'),
  toggle: document.getElementById('black-out-toggle'),
  text: document.getElementById('black-out-text'),
  count: document.getElementById('black-out-count'),
  apply: document.getElementById('black-out-apply'),
  status: document.getElementById('black-out-status'),
};

blackout.toggle?.addEventListener('click', () => {
  const open = blackout.panel.hidden;
  blackout.panel.hidden = !open;
  blackout.toggle.setAttribute('aria-expanded', String(open));
  if (open) blackout.text.focus();
});

/** What the panel is currently asking for, in the shape findMatches wants. */
function blackoutSpec() {
  const raw = blackout.text.value.trim();
  const categories = [...blackout.panel.querySelectorAll('.blackout-cats input:checked')].map(
    (box) => box.value,
  );

  // A plain word and a regular expression look the same in a text box, so both
  // are tried: whichever matches, matches. Typing "a.b" to mean three literal
  // characters should not silently become a wildcard, and typing \d{4} should
  // not be searched for letter by letter.
  const spec = { categories };
  if (raw) {
    spec.text = raw;
    if (/[\\^$.*+?()[\]{}|]/.test(raw)) {
      try {
        new RegExp(raw);
        spec.pattern = raw;
      } catch {
        // Not a valid expression, so it was only ever literal text.
      }
    }
  }
  return spec;
}

/**
 * The document to black out in.
 *
 * The only PDF loaded, or the one holding the current selection. With several
 * on the bench and nothing ticked there is no honest answer: silently picking
 * the first would redact a document the user was not looking at.
 */
function blackoutTarget() {
  // A picked document is the plainest answer, and it is the one the rest of the
  // app already uses: picking files out is how every other control is narrowed,
  // so this panel has to honour it too rather than insisting on a ticked page.
  const picked = selectedAssets('pdf');
  if (picked.length === 1) return picked[0];
  if (picked.length > 1) {
    blackout.status.textContent =
      `${picked.length} documents are picked. Black out works on one at a time, so pick just one.`;
    return null;
  }

  const asset = grid.getCurrentAsset();
  if (asset) return asset;
  blackout.status.textContent =
    'Several documents are loaded. Pick the one you mean, or tick a page of it, first.';
  return null;
}

async function runBlackout({ dryRun }) {
  const asset = blackoutTarget();
  if (!asset) return;

  const spec = blackoutSpec();
  if (!spec.text && spec.categories.length === 0) {
    blackout.status.textContent = 'Type something to find, or tick a category.';
    return;
  }

  blackout.status.textContent = 'Looking...';
  blackout.count.disabled = blackout.apply.disabled = true;

  try {
    const { findMatches, rasterisePages } = await import('./core/redact.js');
    const { total, pages } = await findMatches(asset.bytes, spec);

    if (total === 0) {
      blackout.status.textContent = `Nothing matched in ${asset.name}.`;
      return;
    }
    const where = `${total} match${total === 1 ? '' : 'es'} on ${pages.length} page${
      pages.length === 1 ? '' : 's'
    }`;
    if (dryRun) {
      blackout.status.textContent = `${where}. Nothing changed yet.`;
      return;
    }

    blackout.status.textContent = 'Flattening those pages...';
    const rendered = await rasterisePages(asset.bytes, pages);

    const what = [
      spec.text && `"${spec.text}"`,
      spec.categories.length && spec.categories.join(', '),
    ]
      .filter(Boolean)
      .join(', ');

    pushOperation({
      type: 'redact',
      assetIds: asset.id,
      params: { rendered, pages: pages.map((entry) => entry.page) },
      summary: `Redact ${total} match${total === 1 ? '' : 'es'} of ${what}`,
      source: 'user',
    });
    blackout.status.textContent = `${where} blacked out. Undo it in Changes so far.`;
  } catch (error) {
    blackout.status.textContent = String(error?.message ?? error);
  } finally {
    blackout.count.disabled = blackout.apply.disabled = false;
  }
}

blackout.count?.addEventListener('click', () => {
  runBlackout({ dryRun: true }).catch((error) =>
    console.error('[keepitoffline] counting failed', error),
  );
});
blackout.apply?.addEventListener('click', () => {
  runBlackout({ dryRun: false }).catch((error) =>
    console.error('[keepitoffline] blackout failed', error),
  );
});
blackout.text?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') blackout.apply.click();
});

els.rotateLeft.addEventListener('click', () => grid.rotateSelected(els.gridHost, 270));
els.rotateRight.addEventListener('click', () => grid.rotateSelected(els.gridHost, 90));

// --- Loading files ---------------------------------------------------------

async function ingest(file) {
  const bytes = await file.arrayBuffer();

  if (file.type === 'application/pdf') {
    // The worker needs its own copy: posting an ArrayBuffer transfers it.
    const meta = await pdfCall('describe', { bytes: bytes.slice(0) });
    addAsset({ name: file.name, kind: 'pdf', bytes, meta });
    return;
  }

  if (file.type.startsWith('image/')) {
    const bitmap = await createImageBitmap(file);
    addAsset({
      name: file.name,
      kind: 'image',
      bytes,
      meta: { width: bitmap.width, height: bitmap.height, type: file.type },
    });
    bitmap.close();
    return;
  }

  if (file.type.startsWith('audio/')) {
    const meta = await audio.probe(bytes, file.type);
    const asset = addAsset({ name: file.name, kind: 'audio', bytes, meta });
    audio
      .waveform(bytes)
      .then((peaks) => {
        asset.meta.peaks = peaks;
        touch();
      })
      .catch((error) => console.error('[keepitoffline] could not read the waveform', error));
    return;
  }

  if (file.type.startsWith('video/')) {
    if (!video.isSupported()) {
      console.warn('[keepitoffline] this browser cannot encode video');
      return;
    }
    const meta = await video.probe(bytes, file.type);
    const asset = addAsset({ name: file.name, kind: 'video', bytes, meta });
    // The poster frame is what the grid shows, so fetch it once up front.
    video
      .grabFrame(bytes, file.type, Math.min(1, meta.duration / 4))
      .then((poster) => {
        asset.meta.poster = poster;
        touch();
      })
      .catch((error) => console.error('[keepitoffline] could not read a frame', error));
    return;
  }

  console.warn('[keepitoffline] unsupported file type', file.type, file.name);
  throw new Error(
    file.type
      ? `${file.type} files are not supported here.`
      : 'That file type is not supported here.',
  );
}

/**
 * Load what was dropped, and say so when something did not load.
 *
 * A file that quietly does nothing reads as a broken page. Whatever can be
 * opened is opened, and the rest is reported once at the end rather than one
 * alert per file.
 */
async function handleFiles(fileList) {
  const rejected = [];
  for (const file of fileList) {
    try {
      await ingest(file);
    } catch (error) {
      console.error('[keepitoffline] could not load', file.name, error);
      rejected.push(`${file.name}: ${error.message}`);
    }
  }

  if (rejected.length > 0) {
    window.alert(
      `Could not open ${rejected.length} file${rejected.length === 1 ? '' : 's'}:\n\n` +
        rejected.join('\n') +
        '\n\nDocuments (PDF), photos, video and sound can be opened.',
    );
  }
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', (event) => {
  const files = [...event.target.files];
  // Clearing the input is what lets the same file be picked again after it has
  // been removed: without this the change event never fires a second time.
  event.target.value = '';
  handleFiles(files);
});

/**
 * The whole window accepts a drop.
 *
 * Aiming at a strip near the top is work the browser does not require: anywhere
 * over the app means the same thing. The page dims to say so, which also makes
 * the target obvious without one being drawn.
 *
 * Counting enter and leave events is what makes this reliable: moving over a
 * child element fires a leave for the parent, so a naive listener flickers.
 */
let dragDepth = 0;

const isFileDrag = (event) => event.dataTransfer?.types?.includes('Files');

window.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth++;
  document.body.classList.add('is-file-dragging');
});

window.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('is-file-dragging');
});

window.addEventListener('drop', (event) => {
  dragDepth = 0;
  document.body.classList.remove('is-file-dragging');
  if (!isFileDrag(event)) return;
  event.preventDefault();
  handleFiles(event.dataTransfer.files);
});

// Sample files go through exactly the same path as a drop, so nothing about the
// app knows or cares that they came from a button. The offer sits right under
// the dropzone and leaves with it.
els.demoLauncher = demoLoader.init({
  after: els.dropzone,
  onLoad: (files) => handleFiles(files),
});

// --- Export ----------------------------------------------------------------

function download(bytes, type, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Apply the stack to one file and return the bytes, without downloading. */
async function renderAsset(asset, onProgress) {
  const plain = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));

  if (asset.kind === 'audio') {
    const result = await audio.render({ bytes: asset.bytes, meta: asset.meta, operations: plain });
    return {
      bytes: result.bytes,
      type: result.type,
      filename: `${asset.name.replace(/\.[^.]+$/, '')}-edited.wav`,
    };
  }

  if (asset.kind === 'video') {
    // Grading runs per frame on the main thread, so the LUT is resolved once
    // here rather than being looked up sixty times a second.
    const grade = plain.find((op) => op.type === 'apply_lut');
    let gradeFrame;
    if (grade) {
      await ensureLutLoaded(grade.params.lut_name);
      const lut = await lutFor(grade.params.lut_name);
      gradeFrame = (data) => applyLutToPixels(data, lut, grade.params.intensity ?? 1);
    }

    const result = await video.render({
      bytes: asset.bytes,
      type: asset.meta.type,
      meta: asset.meta,
      operations: plain,
      gradeFrame,
      onProgress,
    });
    const extension = result.type.includes('mp4') ? 'mp4' : 'webm';
    return {
      bytes: result.bytes,
      type: result.type,
      filename: `${asset.name.replace(/\.[^.]+$/, '')}-edited.${extension}`,
    };
  }

  if (asset.kind === 'pdf') {
    const { bytes } = await pdfCall('apply', { bytes: asset.bytes.slice(0), operations: plain });
    return {
      bytes,
      type: 'application/pdf',
      filename: asset.name.replace(/\.pdf$/i, '') + '-edited.pdf',
    };
  }

  // Any look in the stack has to reach the worker before it can be applied.
  for (const op of plain) {
    if (op.type === 'apply_lut') await ensureLutLoaded(op.params.lut_name);
  }

  const result = await imageCall('process', {
    bytes: asset.bytes.slice(0),
    operations: plain,
    type: asset.meta.type,
  });

  const extension = result.type.split('/')[1].replace('jpeg', 'jpg');
  const base = asset.name.replace(/\.[^.]+$/, '');
  return { bytes: result.bytes, type: result.type, filename: `${base}-edited.${extension}` };
}

/**
 * Is there anything to save for this file?
 *
 * Queued edits count, and so does being the product of a join: a combined
 * document is itself the change, even before anything is done to it.
 */
function hasPendingWork(asset) {
  return operationsFor(asset.id).length > 0 || isJoinProduct(asset.id);
}

async function exportAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset || !hasPendingWork(asset)) return;
  const { bytes, type, filename } = await renderAsset(asset);
  download(bytes, type, filename);
}

/**
 * Export everything with pending work.
 *
 * A single file downloads as itself. Several arrive as one zip: browsers block
 * repeated downloads from a page, so firing forty of them would silently lose
 * most of the batch.
 */
async function exportAll() {
  const pending = listAssets().filter(hasPendingWork);
  if (pending.length === 0) return;

  if (pending.length === 1) {
    await exportAsset(pending[0].id);
    return;
  }

  setExportProgress(0, pending.length);
  const files = {};
  for (const [index, asset] of pending.entries()) {
    const { bytes, filename } = await renderAsset(asset, (fraction) => {
      setExportProgress(index + fraction, pending.length);
    });
    files[filename] = new Uint8Array(bytes);
    setExportProgress(index + 1, pending.length);
  }

  const { zipSync } = await import('../assets/vendor/fflate.mjs');
  // The zip is built in memory from files that were already in memory: still
  // nothing leaves the browser.
  const zipped = zipSync(files, { level: 6 });
  download(zipped, 'application/zip', 'keepitoffline.zip');
  setExportProgress(null);
}

function setExportProgress(done, total) {
  if (done === null) {
    els.exportBtn.textContent = 'Apply and download';
    els.exportBtn.disabled = false;
    return;
  }
  els.exportBtn.disabled = true;
  els.exportBtn.textContent = `Preparing ${Math.min(total, Math.floor(done) + 1)} of ${total}...`;
}

els.exportBtn.addEventListener('click', () => {
  exportAll().catch((error) => console.error('[keepitoffline] export failed', error));
});

/**
 * Join several PDFs into one, applying each one's queued changes first.
 *
 * The result lands on the bench rather than in the downloads folder. Joining is
 * an edit, not an export: the combined document is the thing the user is now
 * working on, and they should be able to keep going with it, black something
 * out in it, and only then save a copy. It also means the two documents stop
 * being two on screen, which is what joining them was for.
 */
async function mergePdfs(assetIds, name, { order, note } = {}) {
  const assets = assetIds.map((id) => getAsset(id)).filter(Boolean);
  if (assets.length < 2) return null;

  const sources = assets.map((asset) => ({
    bytes: asset.bytes.slice(0),
    operations: operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params })),
  }));

  const { bytes, pageCount } = await pdfCall('merge', { sources, order });
  const merged = addAsset({
    name: name || 'combined.pdf',
    kind: 'pdf',
    bytes,
    // Marked as made rather than opened, so the workspace knows it has no life
    // of its own once the join that produced it is gone. builtFrom records the
    // source operations these bytes were built from, so rebuildJoins can tell
    // whether they are still current.
    meta: {
      pageCount,
      joined: true,
      builtFrom: JSON.stringify(sources.map((s) => s.operations)),
    },
  });

  // The sources stay on the bench, hidden behind the join rather than deleted.
  // That is what lets this be undone: untick the row and the two documents are
  // back, each with the edits that were queued against it.
  pushOperation({
    type: 'join',
    // The order is kept so the join can be rebuilt when a source's own changes
    // are edited afterwards: without it a rebuild would lose a page that had
    // been dragged from one half into the other.
    params: { sources: assets.map((a) => a.id), merged: merged.id, order },
    // A join that was really "put this page there" says so: the drag did two
    // things and the row has to account for both, or the move is invisible on
    // the stack and only the join looks undoable.
    summary: note
      ? `${note}, joining ${assets.map((a) => a.name).join(' and ')}`
      : `Join ${assets.map((a) => a.name).join(' and ')} into one document`,
    source: 'user',
  });
  return merged;
}

window.addEventListener('keepitoffline:merge', (event) => {
  mergePdfs(event.detail.assetIds, event.detail.name)
    .then((merged) => {
      // "Merge and download" is one request, so it is one action here too:
      // asking for a file and then being handed nothing is the worst of both.
      if (merged && event.detail.download) return exportAsset(merged.id);
    })
    .catch((error) => console.error('[keepitoffline] could not merge', error));
});

/**
 * Rebuild a combined document when the changes inside one of its halves move.
 *
 * A join bakes its sources' edits into new bytes, which is what makes the
 * result a real document you can keep working on. The cost is that those bytes
 * are a snapshot: unticking a redaction that happened before the join used to
 * leave the row looking undone while the black bars stayed burned into the
 * combined file. The row was telling the truth about the source and a lie about
 * what was on screen.
 *
 * So the join is recomputed whenever the operations feeding it change. The
 * merged asset keeps its id, so the stack, the selection and the grid all stay
 * pointing at the same document.
 */
let rebuilding = false;
async function rebuildJoins() {
  if (rebuilding) return;
  const joins = getState().operations.filter((op) => op.type === 'join' && op.enabled);
  if (joins.length === 0) return;

  rebuilding = true;
  try {
    for (const join of joins) {
      const merged = getAsset(join.params.merged);
      if (!merged) continue;

      const sources = join.params.sources
        .map((id) => getAsset(id))
        .filter(Boolean)
        .map((asset) => ({
          bytes: asset.bytes.slice(0),
          operations: operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params })),
        }));
      if (sources.length < 2) continue;

      // The fingerprint is what the join is made of: rebuild only when it moves,
      // or every render would re-run the merge and the app would never settle.
      const fingerprint = JSON.stringify(sources.map((s) => s.operations));
      if (merged.meta.builtFrom === fingerprint) continue;

      const { bytes, pageCount } = await pdfCall('merge', {
        sources,
        order: join.params.order,
      });
      merged.bytes = bytes;
      merged.meta.pageCount = pageCount;
      merged.meta.builtFrom = fingerprint;
      touch();
    }
  } catch (error) {
    console.error('[keepitoffline] could not rebuild a join', error);
  } finally {
    rebuilding = false;
  }
}

/**
 * A page dragged from one document into another.
 *
 * Crossing the boundary is the user saying these are one document. Two PDFs
 * cannot share a page while they stay two files, so the drop joins them and
 * then puts the page where the pointer left it. From here on there is one
 * document, one heading, and no boundary to cross.
 */
async function mixPages({ fromAssetId, sourceIndex, intoAssetId, atIndex }) {
  const from = getAsset(fromAssetId);
  const into = getAsset(intoAssetId);
  if (!from || !into) return;

  // Bench order decides which half of the joined document comes first, so the
  // pages arrive laid out the way they were on screen.
  const order = listAssets('pdf')
    .filter((asset) => asset.id === fromAssetId || asset.id === intoAssetId)
    .map((asset) => asset.id);

  const pagesOf = (asset) =>
    previewPages(
      asset.meta.pageCount,
      operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params })),
    );

  // Where the dragged page and the drop gap land once the two are one run.
  const leading = order[0] === intoAssetId ? into : from;
  const leadCount = pagesOf(leading).length;
  const offsetOf = (assetId) => (assetId === leading.id ? 0 : leadCount);

  const inFrom = pagesOf(from).findIndex((page) => page.sourceIndex === sourceIndex);
  // A page already queued for removal is not in the joined run at all, so there
  // is nothing to place. Joining the documents is still what the drag asked for.
  const movedFrom = inFrom === -1 ? -1 : offsetOf(fromAssetId) + inFrom;
  const dropAt = offsetOf(intoAssetId) + atIndex;

  const total = leadCount + pagesOf(leading.id === from.id ? into : from).length;
  let pageOrder;
  if (movedFrom >= 0 && movedFrom < total) {
    pageOrder = [...Array(total).keys()];
    const target = Math.max(0, Math.min(dropAt > movedFrom ? dropAt - 1 : dropAt, total - 1));
    if (target !== movedFrom) {
      const [moved] = pageOrder.splice(movedFrom, 1);
      pageOrder.splice(target, 0, moved);
    }
  }

  // The page lands in place as part of the join rather than as a second step,
  // so the whole gesture is one row on the stack and one thing to undo. The row
  // still names the move, in the numbering of the document you end up with,
  // because "join" alone does not describe what the drag did.
  const landedAt = pageOrder ? pageOrder.indexOf(movedFrom) : -1;
  const note =
    landedAt >= 0
      ? `Move ${from.name} page ${inFrom + 1} to position ${landedAt + 1}`
      : undefined;

  await mergePdfs(order, combinedName(order.map(getAsset)), { order: pageOrder, note });
}

/**
 * A name for documents that have become one.
 *
 * Built from the names in the order the pages now run, so the file says what it
 * holds. Long names are cut rather than stacked: three or four joins should not
 * produce a filename nobody can read.
 */
function combinedName(assets) {
  const stem = assets
    .filter(Boolean)
    .map((asset) => asset.name.replace(/\.pdf$/i, ''))
    .join('-')
    .slice(0, 76);
  return `${stem || 'combined'}.pdf`;
}

window.addEventListener('keepitoffline:mix-pages', (event) => {
  mixPages(event.detail).catch((error) =>
    console.error('[keepitoffline] could not mix the pages', error),
  );
});

// Tools ask the UI to export rather than downloading behind the user's back.
window.addEventListener('keepitoffline:export', (event) => exportAsset(event.detail.assetId));

// --- Rendering -------------------------------------------------------------

/** One line describing a file, in the terms that matter for its kind. */
function describeAsset(asset) {
  const { meta } = asset;
  switch (asset.kind) {
    case 'pdf':
      return `PDF · ${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'} · ${asset.id}`;
    case 'image':
      return `Image · ${meta.width}×${meta.height} · ${asset.id}`;
    case 'video':
      return `Video · ${meta.width}×${meta.height} · ${meta.duration.toFixed(1)}s · ${asset.id}`;
    case 'audio':
      return `Audio · ${meta.duration.toFixed(1)}s · ${meta.channels === 1 ? 'mono' : 'stereo'} · ${asset.id}`;
    default:
      return asset.id;
  }
}

function renderAssets(state) {
  const busy = listAssets().length > 0;

  // The headline and the dropzone have both done their job once there is work
  // on the bench: they shrink to a line, and the files take the space.
  const lede = document.getElementById('lede');
  if (lede) {
    lede.classList.toggle('is-compact', busy);
    lede.querySelector('.lede-title').textContent = busy
      ? 'Your files'
      : 'Your files stay on your computer.';
  }
  document.getElementById('start-over').hidden = !busy;

  // The zoom for whichever grid is on screen sits beside the heading, so the
  // three columns start on the same line. Which one that is follows the same
  // order the editors appear in.
  const zoomSlot = document.getElementById('bench-zoom');
  const kinds = new Set(listAssets().map((a) => a.kind));
  const editorId = kinds.has('pdf')
    ? 'editor'
    : kinds.has('image')
      ? 'image-editor'
      : kinds.has('video')
        ? 'video-editor'
        : null;

  const wanted = editorId
    ? document.querySelector(`#${editorId} .worktools`) ??
      [...zoomSlot.children].find((el) => el.dataset.editor === editorId)
    : null;

  if (wanted) {
    wanted.dataset.editor = editorId;
    if (wanted.parentElement !== zoomSlot) zoomSlot.append(wanted);
  }
  // Only the one belonging to the visible grid is shown, and this runs whether
  // or not there is a wanted one: the sliders are parked here for later reuse,
  // so leaving a stale flag behind means two of them appear side by side the
  // next time the slot opens.
  for (const child of zoomSlot.children) child.hidden = child !== wanted;
  zoomSlot.hidden = !wanted;
  // With the whole window taking drops, the strip is only needed while the
  // bench is empty and there is nothing else to aim at. The sample offer under
  // it goes with it.
  els.dropzone.hidden = busy;
  if (els.demoLauncher) els.demoLauncher.hidden = busy;

  // Files with no grid of their own still need a way off the bench.
  els.assetList.replaceChildren();
  const loadedPdfs = listAssets('pdf');
  for (const asset of listAssets()) {
    if (asset.kind !== 'pdf') continue;

    const li = document.createElement('li');
    li.className = `asset asset-${asset.kind}`;
    // The chip is tinted to match its group on the bench, but only while there
    // is more than one document: a lone PDF has nothing to be told apart from.
    if (loadedPdfs.length > 1) {
      li.dataset.band = String(loadedPdfs.indexOf(asset) % 4);
    }

    const info = document.createElement('div');
    info.className = 'asset-info';
    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = asset.name;
    const detail = document.createElement('span');
    detail.className = 'asset-detail';
    detail.textContent = describeAsset(asset);
    info.append(name, detail);

    li.append(info, makeRemoveButton(asset));
    els.assetList.append(li);
  }

  // Joining is the reason documents keep a row of their own: it is the one
  // action that is about the files rather than about the pages inside them.
  const pdfs = listAssets('pdf');
  if (pdfs.length > 1) {
    const merge = document.createElement('li');
    merge.className = 'asset-action';
    const button = document.createElement('button');
    button.className = 'ghost';
    button.type = 'button';
    button.textContent = `Join ${pdfs.length} documents into one`;
    button.addEventListener('click', () => {
      mergePdfs(pdfs.map((a) => a.id), combinedName(pdfs)).catch((error) =>
        console.error('[keepitoffline] could not merge', error),
      );
    });
    merge.append(button);
    els.assetList.append(merge);
  }
}

// --- Selection ---------------------------------------------------------------
// One line per kind, saying what the controls beside it will act on. The three
// kinds behave identically, so they are described once as data.

const SCOPES = [
  { kind: 'image', noun: 'photo', nouns: 'photos', all: 'every loaded image' },
  { kind: 'video', noun: 'clip', nouns: 'clips', all: 'every loaded video' },
  { kind: 'audio', noun: 'track', nouns: 'tracks', all: 'every loaded track' },
];

for (const { kind } of SCOPES) {
  document
    .getElementById(`${kind}-select-all`)
    ?.addEventListener('click', () =>
      setSelection(listAssets(kind).map((a) => a.id), kind),
    );
  document
    .getElementById(`${kind}-select-none`)
    ?.addEventListener('click', () => clearSelection(kind));
}

/**
 * Clicking the empty space around the files lets them all go.
 *
 * This is what people expect from anything that holds a selection, and it saves
 * hunting for a Clear button. The bar is deliberately high: only a click that
 * landed on nothing at all counts. A click on a file, on any control, or on the
 * panels either side means something else, and a drag that happens to end on
 * open space is a reorder, not a click.
 */
document.addEventListener('click', (event) => {
  if (getState().selection.size === 0) return;

  const target = event.target;
  if (
    target.closest(
      '.image-cell, .video-cell, .audio-row, .rail, .side, .topbar, ' +
        '.viewer, .demo-launcher, button, input, select, label, a',
    )
  ) {
    return;
  }
  clearSelection();
});

/**
 * Say what the next control will do, in the same words the stack will use.
 *
 * The line is the only thing standing between "I moved a slider" and "I moved a
 * slider over forty photographs", so it is never blank and never ambiguous.
 */
function renderScopes() {
  for (const { kind, noun, nouns, all } of SCOPES) {
    const line = document.getElementById(`${kind}-scope`);
    if (!line) continue;

    const loaded = listAssets(kind);
    const chosen = selectedAssets(kind);
    const narrowed = chosen.length > 0;

    line.textContent = narrowed
      ? `Applies to ${chosen.length} selected ${chosen.length === 1 ? noun : nouns}`
      : `Applies to ${all}`;
    line.classList.toggle('is-narrowed', narrowed);

    // Selecting everything by hand is the same as selecting nothing, so the
    // offer is only worth making while it would actually change something.
    const selectAll = document.getElementById(`${kind}-select-all`);
    if (selectAll) selectAll.hidden = loaded.length < 2 || chosen.length === loaded.length;
    const selectNone = document.getElementById(`${kind}-select-none`);
    if (selectNone) selectNone.hidden = !narrowed;
  }
}

/** A close button that asks first: removing a file drops its edits with it. */
export function makeRemoveButton(asset) {
  const button = document.createElement('button');
  button.className = 'asset-remove';
  button.type = 'button';
  button.title = `Take ${asset.name} off the bench`;
  button.setAttribute('aria-label', `Remove ${asset.name}`);
  button.textContent = '×';
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const queued = operationsFor(asset.id).length;
    const warning = queued
      ? `Remove ${asset.name}? It has ${queued} change${queued === 1 ? '' : 's'} that will go with it.`
      : `Remove ${asset.name} from the bench?`;
    if (window.confirm(warning)) {
      grid.forget(asset.id);
      removeAsset(asset.id);
    }
  });
  return button;
}

function renderOperations(state) {
  els.opList.replaceChildren();
  document.getElementById('clear-changes').hidden = state.operations.length === 0;
  // Nothing to take back until something has been done, whoever did it.
  document.getElementById('undo-last').hidden = state.operations.length === 0;

  if (state.operations.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No operations queued.';
    els.opList.append(li);
    els.exportBtn.disabled = true;
    return;
  }

  for (const op of state.operations) {
    const li = document.createElement('li');
    li.className = 'op' + (op.enabled ? '' : ' is-disabled');

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = op.enabled;
    toggle.addEventListener('change', () => setOperationEnabled(op.id, toggle.checked));

    const label = document.createElement('span');
    label.className = 'op-summary';
    label.textContent = op.summary;

    const badge = document.createElement('span');
    badge.className = `badge badge-${op.source}`;
    badge.textContent = op.source === 'agent' ? 'agent' : 'you';

    const drop = document.createElement('button');
    drop.className = 'ghost';
    drop.textContent = '×';
    drop.title = 'Discard this operation';
    drop.addEventListener('click', () => removeOperation(op.id));

    li.append(toggle, label, badge, drop);
    els.opList.append(li);
  }

  els.exportBtn.disabled = state.operations.every((op) => !op.enabled);
}

function renderTools(names) {
  els.toolList.replaceChildren();
  for (const name of names) {
    const li = document.createElement('li');
    li.className = 'tool';
    li.textContent = name;
    els.toolList.append(li);
  }
}

/**
 * Move the control bars into the left rail, and leave the middle column to the
 * work itself.
 *
 * The panels are built where they are declared, so this relocates them rather
 * than duplicating them: one set of controls, one set of listeners, wherever
 * they happen to sit on screen.
 */
function layoutRail(state) {
  const rail = document.getElementById('rail');
  const body = document.getElementById('rail-body');

  // Every bar in an editor moves, however many it has: naming them one by one
  // meant a later addition (the mask row) was silently left behind.
  const groups = [
    ['pdf', 'Pages', '#editor'],
    ['image', 'Photos', '#image-editor'],
    ['video', 'Video', '#video-editor'],
    ['audio', 'Sound', '#audio-editor'],
  ];

  const kinds = new Set(listAssets().map((a) => a.kind));
  rail.hidden = kinds.size === 0;

  for (const [kind, label, editorSelector] of groups) {
    let section = body.querySelector(`[data-kind="${kind}"]`);

    if (!kinds.has(kind)) {
      // The bars are borrowed, not owned: hand them back before dropping the
      // section, or removing the last file of a kind destroys its controls and
      // they are gone for good when a file of that kind is loaded again.
      if (section) {
        const editor = document.querySelector(editorSelector);
        for (const bar of section.querySelectorAll('.actionbar')) editor?.append(bar);
        section.remove();
      }
      continue;
    }
    if (!section) {
      section = document.createElement('section');
      section.className = `rail-group rail-${kind}`;
      section.dataset.kind = kind;
      const heading = document.createElement('h3');
      heading.textContent = label;
      section.append(heading);
      body.append(section);
    }
    const editor = document.querySelector(editorSelector);
    for (const bar of editor?.querySelectorAll(':scope > .actionbar') ?? []) {
      section.append(bar);
    }
  }
}

subscribe((state) => {
  renderAssets(state);
  renderOperations(state);
  renderScopes();
  layoutRail(state);

  // A combined document is built from its halves, so it has to follow them when
  // their changes move. This is a no-op unless a join's inputs actually
  // changed, and it notifies again when it rebuilds, which redraws the grid.
  rebuildJoins();

  // Show the first PDF in the editor, and keep the grid in step with the stack
  // so a page removed by the agent greys out as soon as the tool returns.
  const images = listAssets('image');
  els.imageEditor.hidden = images.length === 0;
  if (images.length > 0) {
    imagePanel
      .refresh(images)
      .catch((error) => console.error('[keepitoffline] image preview failed', error));
  }

  const videos = listAssets('video');
  els.videoEditor.hidden = videos.length === 0;
  if (videos.length > 0) videoPanel.refresh(videos);

  const tracks = listAssets('audio');
  els.audioEditor.hidden = tracks.length === 0;
  if (tracks.length > 0) audioPanel.refresh(tracks);

  // Every PDF is drawn, each in its own group. showAssets() rebuilds only when
  // the set of documents changes and otherwise just refreshes, so a queued
  // operation costs a repaint rather than a re-render of every thumbnail.
  const pdfs = listAssets('pdf');
  els.editor.hidden = pdfs.length === 0;
  grid
    .showAssets(els.gridHost)
    .catch((error) => console.error('[keepitoffline] could not draw the pages', error));
});

// --- Agent wiring ----------------------------------------------------------

if (isSupported) {
  els.agentStatus.hidden = false;
  onRegistryChange((names) => {
    renderTools(names);
    els.agentStatusText.textContent = `Agent ready · ${names.length} tools`;
  });
  start();
} else {
  // No WebMCP here. The app is complete without it, so this is a note, not an error.
  els.toolsHint.textContent =
    'This browser does not expose WebMCP, so no tools are registered. Every feature still works by hand.';
}

renderAssets(getState());
renderOperations(getState());
renderScopes();
