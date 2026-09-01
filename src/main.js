// Entry point. The app is fully usable with no agent attached: WebMCP only ever
// adds a second way to drive the same state.

import {
  addAsset,
  clearOperations,
  getAsset,
  getState,
  operationsFor,
  removeAsset,
  removeOperation,
  pushOperation,
  setOperationEnabled,
  subscribe,
  touch,
} from './core/workspace.js';
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

// Two different retreats, kept apart on purpose. Undo all keeps the files and
// drops the edits; Start over clears the bench entirely.
document.getElementById('clear-changes').addEventListener('click', () => {
  const count = getState().operations.length;
  if (!count) return;
  if (window.confirm(`Undo all ${count} change${count === 1 ? '' : 's'}? Your files stay where they are.`)) {
    clearOperations();
  }
});

document.getElementById('start-over').addEventListener('click', () => {
  const state = getState();
  if (state.assets.length === 0) return;
  const files = state.assets.length;
  const changes = state.operations.length;
  const detail = changes
    ? `${files} file${files === 1 ? '' : 's'} and ${changes} change${changes === 1 ? '' : 's'}`
    : `${files} file${files === 1 ? '' : 's'}`;
  if (window.confirm(`Start over? This clears ${detail} from the bench.`)) {
    clearOperations();
    for (const asset of [...state.assets]) removeAsset(asset.id);
  }
});

document.getElementById('remove-blank').addEventListener('click', async () => {
  const pdf = getState().assets.find((a) => a.kind === 'pdf');
  if (!pdf) return;
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
// app knows or cares that they came from a button.
demoLoader.init({ onLoad: (files) => handleFiles(files) });

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

async function exportAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset || operationsFor(asset.id).length === 0) return;
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
  const pending = getState().assets.filter((a) => operationsFor(a.id).length > 0);
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

/** Join several PDFs, applying each one's queued changes first. */
async function mergePdfs(assetIds, name) {
  const sources = assetIds
    .map((id) => getAsset(id))
    .filter(Boolean)
    .map((asset) => ({
      bytes: asset.bytes.slice(0),
      operations: operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params })),
    }));
  if (sources.length < 2) return;

  const { bytes } = await pdfCall('merge', { sources });
  download(bytes, 'application/pdf', name || 'combined.pdf');
}

window.addEventListener('keepitoffline:merge', (event) => {
  mergePdfs(event.detail.assetIds, event.detail.name).catch((error) =>
    console.error('[keepitoffline] could not merge', error),
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
  const busy = state.assets.length > 0;

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
  const kinds = new Set(state.assets.map((a) => a.kind));
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
    // Only the one that belongs to the visible grid is shown.
    for (const child of zoomSlot.children) child.hidden = child !== wanted;
  }
  zoomSlot.hidden = !wanted;
  // With the whole window taking drops, the strip is only needed while the
  // bench is empty and there is nothing else to aim at.
  els.dropzone.hidden = busy;

  // Files with no grid of their own still need a way off the bench.
  els.assetList.replaceChildren();
  for (const asset of state.assets) {
    if (asset.kind !== 'pdf') continue;

    const li = document.createElement('li');
    li.className = `asset asset-${asset.kind}`;

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
  const pdfs = state.assets.filter((a) => a.kind === 'pdf');
  if (pdfs.length > 1) {
    const merge = document.createElement('li');
    merge.className = 'asset-action';
    const button = document.createElement('button');
    button.className = 'ghost';
    button.type = 'button';
    button.textContent = `Join ${pdfs.length} documents into one`;
    button.addEventListener('click', () => {
      mergePdfs(pdfs.map((a) => a.id), 'combined.pdf').catch((error) =>
        console.error('[keepitoffline] could not merge', error),
      );
    });
    merge.append(button);
    els.assetList.append(merge);
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
    if (window.confirm(warning)) removeAsset(asset.id);
  });
  return button;
}

function renderOperations(state) {
  els.opList.replaceChildren();
  document.getElementById('clear-changes').hidden = state.operations.length === 0;

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

  const kinds = new Set(state.assets.map((a) => a.kind));
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
  layoutRail(state);

  // Show the first PDF in the editor, and keep the grid in step with the stack
  // so a page removed by the agent greys out as soon as the tool returns.
  const images = state.assets.filter((a) => a.kind === 'image');
  els.imageEditor.hidden = images.length === 0;
  if (images.length > 0) {
    imagePanel
      .refresh(images)
      .catch((error) => console.error('[keepitoffline] image preview failed', error));
  }

  const videos = state.assets.filter((a) => a.kind === 'video');
  els.videoEditor.hidden = videos.length === 0;
  if (videos.length > 0) videoPanel.refresh(videos);

  const tracks = state.assets.filter((a) => a.kind === 'audio');
  els.audioEditor.hidden = tracks.length === 0;
  if (tracks.length > 0) audioPanel.refresh(tracks);

  const pdf = state.assets.find((a) => a.kind === 'pdf');
  const shown = grid.getCurrentAsset();

  if (!pdf) {
    els.editor.hidden = true;
    if (shown) grid.showAsset(null, els.gridHost);
    return;
  }

  els.editor.hidden = false;
  if (!shown || shown.id !== pdf.id) {
    grid.showAsset(pdf, els.gridHost).then(() => grid.refresh(els.gridHost));
  } else {
    grid.refresh(els.gridHost);
  }
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
