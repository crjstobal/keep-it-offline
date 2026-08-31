// Entry point. The app is fully usable with no agent attached: WebMCP only ever
// adds a second way to drive the same state.

import {
  addAsset,
  getAsset,
  getState,
  operationsFor,
  removeAsset,
  removeOperation,
  setOperationEnabled,
  subscribe,
} from './core/workspace.js';
import { isSupported, onRegistryChange, start } from './core/registry.js';
import { imageCall, pdfCall } from './core/worker-bridge.js';
import { ensureLutLoaded } from './core/luts.js';
import * as grid from './ui/page-grid.js';
import * as imagePanel from './ui/image-panel.js';

import './tools/workspace-tools.js';
import './tools/pdf-tools.js';
import './tools/image-tools.js';

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
};

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

els.removeSelected.addEventListener('click', () => grid.removeSelected(els.gridHost));
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

// --- Export ----------------------------------------------------------------

function download(bytes, type, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportAsset(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return;

  const ops = operationsFor(asset.id);
  if (ops.length === 0) return;
  const plain = ops.map((op) => ({ type: op.type, params: op.params }));

  if (asset.kind === 'pdf') {
    const { bytes } = await pdfCall('apply', { bytes: asset.bytes.slice(0), operations: plain });
    download(bytes, 'application/pdf', asset.name.replace(/\.pdf$/i, '') + '-edited.pdf');
    return;
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
  download(result.bytes, result.type, `${base}-edited.${extension}`);
}

/** Export every file that has enabled operations, for a batch. */
async function exportAll() {
  for (const asset of getState().assets) {
    if (operationsFor(asset.id).length > 0) await exportAsset(asset.id);
  }
}

els.exportBtn.addEventListener('click', () => {
  exportAll().catch((error) => console.error('[keepitoffline] export failed', error));
});

// Tools ask the UI to export rather than downloading behind the user's back.
window.addEventListener('keepitoffline:export', (event) => exportAsset(event.detail.assetId));

// --- Rendering -------------------------------------------------------------

function renderAssets(state) {
  els.assetList.replaceChildren();
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
    detail.textContent =
      asset.kind === 'pdf'
        ? `PDF · ${asset.meta.pageCount} pages · ${asset.id}`
        : `Image · ${asset.meta.width}×${asset.meta.height} · ${asset.id}`;
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
