// Entry point. The app is fully usable with no agent attached: WebMCP only ever
// adds a second way to drive the same state.

import {
  addAsset,
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
  applySpeed: document.getElementById('apply-speed'),
});

videoPanel.init({
  grid: document.getElementById('video-grid'),
  look: document.getElementById('video-look'),
  applyLook: document.getElementById('video-apply-look'),
  rotateLeft: document.getElementById('video-rotate-left'),
  rotateRight: document.getElementById('video-rotate-right'),
  orientation: document.getElementById('video-orientation'),
});

imagePanel.init({
  grid: document.getElementById('image-grid'),
  lookSelect: document.getElementById('look-select'),
  lookStrength: document.getElementById('look-strength'),
  lookStrengthValue: document.getElementById('look-strength-value'),
  applyLook: document.getElementById('apply-look'),
  resizeWidth: document.getElementById('resize-width'),
  applyResize: document.getElementById('apply-resize'),
  formatSelect: document.getElementById('format-select'),
  applyFormat: document.getElementById('apply-format'),
  rotateLeft: document.getElementById('image-rotate-left'),
  rotateRight: document.getElementById('image-rotate-right'),
  orientation: document.getElementById('image-orientation'),
  brightness: document.getElementById('adj-brightness'),
  contrast: document.getElementById('adj-contrast'),
  saturation: document.getElementById('adj-saturation'),
  vibrance: document.getElementById('adj-vibrance'),
  applyAdjust: document.getElementById('apply-adjust'),
  resetAdjust: document.getElementById('reset-adjust'),
  vignette: document.getElementById('adj-vignette'),
  applyVignette: document.getElementById('apply-vignette'),
  watermarkText: document.getElementById('watermark-text'),
  watermarkPosition: document.getElementById('watermark-position'),
  applyWatermark: document.getElementById('apply-watermark'),
  maskShape: document.getElementById('mask-shape'),
  maskSize: document.getElementById('mask-size'),
  maskX: document.getElementById('mask-x'),
  maskY: document.getElementById('mask-y'),
  maskBorder: document.getElementById('mask-border'),
  maskBorderColor: document.getElementById('mask-border-color'),
  reshuffleBlob: document.getElementById('reshuffle-blob'),
  applyMask: document.getElementById('apply-mask'),
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
document.getElementById('files-summary').addEventListener('toggle', () => {
  renderAssets(getState());
});

const thumbSize = document.getElementById('thumb-size');
thumbSize.addEventListener('input', () => {
  els.gridHost.style.setProperty('--thumb-size', `${thumbSize.value}px`);
});
els.gridHost.style.setProperty('--thumb-size', `${thumbSize.value}px`);

// Each grid has its own size control, since a contact sheet of photographs and
// a row of video players want very different defaults.
for (const [id, apply] of [
  ['image-thumb-size', (value) => imagePanel.setThumbSize(value)],
  ['video-thumb-size', (value) => videoPanel.setThumbSize(value)],
]) {
  const slider = document.getElementById(id);
  slider.addEventListener('input', () => apply(Number(slider.value)));
  apply(Number(slider.value));
}

els.removeSelected.addEventListener('click', () => grid.removeSelected(els.gridHost));

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
}

async function handleFiles(fileList) {
  for (const file of fileList) {
    try {
      await ingest(file);
    } catch (error) {
      console.error('[keepitoffline] could not load', file.name, error);
    }
  }
}

els.dropzone.addEventListener('click', () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener('change', (event) => handleFiles(event.target.files));

for (const type of ['dragenter', 'dragover']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.add('is-over');
  });
}
for (const type of ['dragleave', 'drop']) {
  els.dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    els.dropzone.classList.remove('is-over');
  });
}
els.dropzone.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

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

  const { zipSync } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm');
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
  els.assetList.replaceChildren();

  // The headline has done its job once there is something on the bench.
  const lede = document.getElementById('lede');
  if (lede) {
    lede.classList.toggle('is-compact', state.assets.length > 0);
    if (state.assets.length > 0) lede.querySelector('.lede-title').textContent = 'Your files';
    else lede.querySelector('.lede-title').textContent = 'Your files stay on your computer.';
  }

  // With a batch of photographs the file list is not the interesting part of
  // the page: one line per file would push the previews off the screen
  // entirely. Past a handful, collapse to a summary that can be opened.
  const summary = document.getElementById('files-summary');
  const many = state.assets.length > 4;
  summary.hidden = !many;
  els.assetList.classList.toggle('is-collapsed', many && !summary.open);

  if (many) {
    // Count every kind, not just the two that existed when this was written:
    // a bench holding a video and a track should say so.
    const counts = {};
    for (const asset of state.assets) counts[asset.kind] = (counts[asset.kind] ?? 0) + 1;

    const names = {
      pdf: ['PDF', 'PDFs'],
      image: ['image', 'images'],
      video: ['video', 'videos'],
      audio: ['track', 'tracks'],
    };
    const parts = Object.entries(counts).map(([kind, n]) => {
      const [one, many_] = names[kind] ?? [kind, `${kind}s`];
      return `${n} ${n === 1 ? one : many_}`;
    });

    const listed =
      parts.length <= 1
        ? parts.join('')
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
    summary.querySelector('summary').textContent = `${listed} on the bench`;
  }

  for (const asset of state.assets) {
    const li = document.createElement('li');
    li.className = 'asset';

    const info = document.createElement('div');
    info.className = 'asset-info';
    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = asset.name;
    const detail = document.createElement('span');
    detail.className = 'asset-detail';
    detail.textContent = describeAsset(asset);
    info.append(name, detail);

    const remove = document.createElement('button');
    remove.className = 'ghost';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeAsset(asset.id));

    li.append(info, remove);
    els.assetList.append(li);
  }
}

function renderOperations(state) {
  els.opList.replaceChildren();

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

subscribe((state) => {
  renderAssets(state);
  renderOperations(state);

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
