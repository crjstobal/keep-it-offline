// The manual half of the image tools. Same rule as the page grid: these controls
// and the agent's tools push identical operations onto the same stack.
//
// The look and strength controls preview live, the way rotating a PDF page shows
// the result before anything is committed. Applying only fixes what is already
// on screen.

import {
  getState,
  listAssets,
  moveAssetToIndex,
  operationsFor,
  pushOperation,
  removeAsset,
  removeOperation,
  updateOperation,
} from '../core/workspace.js';
import { availableLuts, ensureLutLoaded } from '../core/luts.js';
import { imageCall } from '../core/worker-bridge.js';
import { openViewer } from './viewer.js';

let els = {};
/** Object URLs currently on screen, revoked before being replaced. */
const previewUrls = new Map();
/** Full-resolution renders for the enlarged viewer, keyed by asset id. */
const fullUrls = new Map();

/** Guards against overlapping preview renders when the slider is dragged. */
let previewToken = 0;

export function init(elements) {
  els = elements;

  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No look';
  els.lookSelect.append(none);

  for (const lut of availableLuts()) {
    const option = document.createElement('option');
    option.value = lut.name;
    option.textContent = lut.name;
    option.title = lut.description;
    els.lookSelect.append(option);
  }

  // These controls cover the photographs as a set, not a fixed list, so the row
  // must not freeze a count that a later drop would make wrong.
  const scopeOfImages = () => {
    const images = listAssets('image');
    return images.length === 1 ? images[0].name : 'every photo';
  };

  /**
   * Push an operation, or edit the one this control already owns.
   *
   * Choosing a look or typing a width is a decision already made, so it goes
   * straight onto the stack: the stack is where it is seen, and unticking it is
   * how it is undone. An Apply button in between only asked people to confirm
   * what they had just said.
   *
   * Dragging is the exception worth handling: a slider fires continuously, and
   * pushing every value would bury the stack. Each live control therefore keeps
   * one row and rewrites it as it moves.
   */
  const live = new Map();
  function commit(key, { type, params, summary }) {
    const images = listAssets('image');
    if (images.length === 0) return;

    const existing = live.get(key);
    if (existing && getState().operations.some((op) => op.id === existing)) {
      updateOperation(existing, { params, summary });
      return;
    }
    const op = pushOperation({
      type,
      scope: 'image',
      params,
      summary,
      source: 'user',
    });
    live.set(key, op.id);
  }

  /** A control that has been returned to neutral owns no row any more. */
  function release(key) {
    const id = live.get(key);
    live.delete(key);
    if (id) removeOperation(id);
  }

  // --- Look ---------------------------------------------------------------
  const applyLook = () => {
    const look = els.lookSelect.value;
    if (!look) {
      release('look');
      return;
    }
    const percent = Number(els.lookStrength.value);
    commit('look', {
      type: 'apply_lut',
      params: { lut_name: look, intensity: percent / 100 },
      summary:
        percent === 100
          ? `Apply the ${look} look to ${scopeOfImages()}`
          : `Apply the ${look} look at ${percent}% to ${scopeOfImages()}`,
    });
  };

  els.lookSelect.addEventListener('change', () => {
    // A new look starts its own row rather than rewriting the last one, so two
    // looks can be stacked.
    live.delete('look');
    applyLook();
  });
  els.lookStrength.addEventListener('input', () => {
    els.lookStrengthValue.textContent = `${els.lookStrength.value}%`;
    applyLook();
  });

  // --- Tonal adjustments --------------------------------------------------
  const readAdjustments = () => ({
    brightness: Number(els.brightness.value) / 100,
    contrast: Number(els.contrast.value) / 100,
    saturation: Number(els.saturation.value) / 100,
    vibrance: Number(els.vibrance.value) / 100,
  });

  const applyAdjustments = () => {
    const params = readAdjustments();
    const set = Object.entries(params).filter(([, v]) => v !== 0);
    if (set.length === 0) {
      release('adjust');
      return;
    }
    const described = set
      .map(([key, value]) => `${key} ${value > 0 ? '+' : ''}${Math.round(value * 100)}`)
      .join(', ');
    commit('adjust', {
      type: 'adjust_image',
      params,
      summary: `Adjust ${scopeOfImages()}: ${described}`,
    });
  };

  for (const key of ['brightness', 'contrast', 'saturation', 'vibrance']) {
    els[key].addEventListener('input', applyAdjustments);
  }

  els.resetAdjust.addEventListener('click', () => {
    for (const key of ['brightness', 'contrast', 'saturation', 'vibrance']) {
      els[key].value = '0';
    }
    els.vignette.value = '0';
    els.lookSelect.value = '';
    els.lookStrength.value = '100';
    els.lookStrengthValue.textContent = '100%';
    release('adjust');
    release('vignette');
    release('look');
  });

  // --- Vignette -----------------------------------------------------------
  els.vignette.addEventListener('input', () => {
    const amount = Number(els.vignette.value) / 100;
    if (amount === 0) {
      release('vignette');
      return;
    }
    commit('vignette', {
      type: 'apply_vignette',
      params: { amount },
      summary: `Vignette ${scopeOfImages()} at ${Math.round(amount * 100)}%`,
    });
  });

  // --- Resize and format --------------------------------------------------
  els.resizeWidth.addEventListener('input', () => {
    const maxWidth = Number(els.resizeWidth.value);
    if (!maxWidth) {
      release('resize');
      return;
    }
    commit('resize', {
      type: 'resize_images',
      params: { max_width: maxWidth },
      summary: `Resize ${scopeOfImages()} to fit ${maxWidth}px wide`,
    });
  });

  els.formatSelect.addEventListener('change', () => {
    const format = els.formatSelect.value;
    if (!format) {
      release('format');
      return;
    }
    commit('format', {
      type: 'convert_format',
      params: { format },
      summary: `Convert ${scopeOfImages()} to ${format.toUpperCase()}`,
    });
  });

  // --- Watermark ----------------------------------------------------------
  const applyWatermark = () => {
    const text = els.watermarkText.value.trim();
    if (!text) {
      release('watermark');
      return;
    }
    const position = els.watermarkPosition.value;
    commit('watermark', {
      type: 'add_watermark',
      params: { text, position, opacity: 0.6, size: 0.05 },
      summary: `Watermark ${scopeOfImages()} with "${text}" (${position})`,
    });
  };
  els.watermarkText.addEventListener('input', applyWatermark);
  els.watermarkPosition.addEventListener('change', applyWatermark);

  // --- Rotation -----------------------------------------------------------
  // A turn is a discrete act, so each press is its own row: pressing twice
  // means two quarter turns, not one row rewritten.
  const queueForAll = (type, params, summary) => {
    const images = listAssets('image');
    if (images.length === 0) return;
    pushOperation({ type, scope: 'image', params, summary, source: 'user' });
  };

  /**
   * Rotation folds into one row rather than stacking.
   *
   * Pressing left twice is a half turn, not two changes to undo separately, and
   * left then right is no rotation at all. Stacking them made the record of
   * what happened longer than what actually happened.
   */
  let rotationOpId = null;
  const turn = (delta) => {
    const existing = getState().operations.find((op) => op.id === rotationOpId);
    const total = (((existing?.params.degrees ?? 0) + delta) % 360 + 360) % 360;

    if (total === 0) {
      if (existing) removeOperation(existing.id);
      rotationOpId = null;
      return;
    }

    const summary = `Rotate ${scopeOfImages()} by ${total}°`;
    if (existing) {
      updateOperation(existing.id, { params: { degrees: total }, summary });
      return;
    }
    const images = listAssets('image');
    if (images.length === 0) return;
    rotationOpId = pushOperation({
      type: 'rotate_image',
      scope: 'image',
      params: { degrees: total },
      summary,
      source: 'user',
    }).id;
  };

  els.rotateLeft.addEventListener('click', () => turn(-90));
  els.rotateRight.addEventListener('click', () => turn(90));
  els.orientation.addEventListener('change', () => {
    const orientation = els.orientation.value;
    if (!orientation) return;
    queueForAll('set_image_orientation', { orientation }, `Make ${scopeOfImages()} ${orientation}`);
    els.orientation.value = '';
  });

  // --- Mask ---------------------------------------------------------------
  let maskSeed = Math.floor(Math.random() * 100000);

  const applyMask = () => {
    const shape = els.maskShape.value;
    els.reshuffleBlob.hidden = shape !== 'blob';
    if (!shape) {
      release('mask');
      return;
    }
    commit('mask', {
      type: 'apply_mask',
      params: {
        shape,
        x: Number(els.maskX.value) / 100,
        y: Number(els.maskY.value) / 100,
        size: Number(els.maskSize.value) / 100,
        seed: maskSeed,
        border_width: Number(els.maskBorder.value) / 10,
        border_color: els.maskBorderColor.value,
      },
      summary: `Mask ${scopeOfImages()} to a ${shape}`,
    });
  };

  els.maskShape.addEventListener('change', () => {
    maskSeed = Math.floor(Math.random() * 100000);
    applyMask();
  });
  for (const control of [els.maskSize, els.maskX, els.maskY, els.maskBorder]) {
    control.addEventListener('input', applyMask);
  }
  els.maskBorderColor.addEventListener('input', applyMask);
  els.reshuffleBlob.addEventListener('click', () => {
    maskSeed = Math.floor(Math.random() * 100000);
    applyMask();
  });
}

/**
 * Dragging the strength slider fires continuously, and each preview is a full
 * pass over every loaded image. Rendering only the most recent request keeps the
 * slider smooth instead of queueing dozens of stale jobs.
 */
let pending = null;
function schedulePreview() {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    refresh(listAssets('image')).catch((error) =>
      console.error('[keepitoffline] preview failed', error),
    );
  }, 90);
}

/**
 * What to preview: the stack, and nothing else.
 *
 * The controls no longer hold a pending state of their own. Everything they say
 * goes onto the stack immediately, so the preview and the stack cannot disagree
 * and there is one place to undo anything.
 */
function previewOperations(assetId) {
  return operationsFor(assetId).map((op) => ({ type: op.type, params: op.params }));
}

export function setThumbSize(px) {
  els.grid.style.setProperty('--thumb-size', `${px}px`);
}

/** Render the images with the stack, and any proposed look, applied. */
export async function refresh(images) {
  if (images.length === 0) {
    els.grid.replaceChildren();
    return;
  }

  const token = ++previewToken;

  // Rebuild only when the set of files changes; otherwise update in place so
  // the images do not flicker on every stack edit.
  const wanted = images.map((a) => a.id).join(',');
  if (els.grid.dataset.assets !== wanted) {
    els.grid.dataset.assets = wanted;
    els.grid.replaceChildren();
    for (const asset of images) {
      els.grid.append(buildCell(asset));
    }
    attachGridReordering();
  }

  for (const asset of images) {
    const cell = els.grid.querySelector(`[data-asset-id="${asset.id}"]`);
    const img = cell?.querySelector('img');
    if (!img) continue;

    const ops = previewOperations(asset.id);

    try {
      for (const op of ops) {
        if (op.type === 'apply_lut') await ensureLutLoaded(op.params.lut_name);
      }
      const result = await imageCall('process', {
        bytes: asset.bytes.slice(0),
        operations: [...ops, { type: 'resize_images', params: { max_width: 480 } }],
        type: asset.meta.type,
      });

      // A newer refresh started while this one was rendering.
      if (token !== previewToken) return;

      const previous = previewUrls.get(asset.id);
      if (previous) URL.revokeObjectURL(previous);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.type }));
      previewUrls.set(asset.id, url);
      img.src = url;
      fullUrls.set(asset.id, url);
    } catch (error) {
      console.error('[keepitoffline] preview failed', asset.name, error);
    }
  }
}

function buildCell(asset) {
  const cell = document.createElement('div');
  cell.className = 'image-cell';
  cell.dataset.assetId = asset.id;
  cell.draggable = true;

  const frame = document.createElement('div');
  frame.className = 'image-frame';

  const img = document.createElement('img');
  img.alt = asset.name;
  img.draggable = false;
  frame.append(img);

  // The controls sit on the picture they act on, rather than in a list of
  // chips repeating what the grid already shows.
  const actions = document.createElement('div');
  actions.className = 'cell-actions';

  const zoom = document.createElement('button');
  zoom.className = 'cell-button';
  zoom.type = 'button';
  zoom.title = `View ${asset.name}`;
  zoom.setAttribute('aria-label', `View ${asset.name}`);
  zoom.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  zoom.addEventListener('click', (event) => {
    event.stopPropagation();
    openImageViewer(asset);
  });

  const remove = document.createElement('button');
  remove.className = 'cell-button cell-remove';
  remove.type = 'button';
  remove.title = `Remove ${asset.name}`;
  remove.setAttribute('aria-label', `Remove ${asset.name}`);
  remove.textContent = '×';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    const queued = operationsFor(asset.id).length;
    const warning = queued
      ? `Remove ${asset.name}? It has ${queued} change${queued === 1 ? '' : 's'} that will go with it.`
      : `Remove ${asset.name} from the bench?`;
    if (window.confirm(warning)) removeAsset(asset.id);
  });

  actions.append(zoom, remove);

  const name = document.createElement('span');
  name.className = 'image-name';
  name.textContent = asset.name;

  cell.append(frame, actions, name);
  attachReordering(cell, asset);
  return cell;
}

/**
 * Drag a photograph to move it.
 *
 * The drop lands *between* two photographs rather than on top of one: a line
 * appears where it would go. Dropping onto a picture reads as "put it here,
 * replacing that", which is not what happens, and leaves you guessing whether
 * the moved item lands before or after.
 *
 * Order is not cosmetic: it decides what a contact sheet or a combined document
 * would look like, so it belongs under the pointer.
 */
function attachReordering(cell, asset) {
  cell.addEventListener('dragstart', (event) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', asset.id);
    cell.classList.add('is-dragging');
  });

  cell.addEventListener('dragend', clearDropMarkers);
}

/**
 * Which gap the pointer is nearest, and where to draw the line.
 *
 * The gaps run along whichever axis the grid is laid out on. At a large zoom a
 * grid can be a single column, where every cell shares the same left and right
 * edge: comparing horizontally there finds nothing, so the axis is chosen from
 * how the cells actually sit.
 */
function gapUnderPointer(event) {
  const cells = [...els.grid.querySelectorAll('.image-cell:not(.is-dragging)')];
  if (cells.length === 0) return null;

  const boxes = cells.map((cell) => cell.getBoundingClientRect());

  // Read the layout from every cell, including the one being dragged: with two
  // photographs, excluding it leaves a single box that can never show whether
  // the grid is one column or two.
  const all = [...els.grid.querySelectorAll('.image-cell')].map((c) => c.getBoundingClientRect());
  const stacked = all.length > 1 && all.every((box) => Math.abs(box.left - all[0].left) < 1);

  let best = null;
  for (const [index, cell] of cells.entries()) {
    const box = boxes[index];
    const edges = stacked
      ? [['before', box.left + box.width / 2, box.top],
         ['after', box.left + box.width / 2, box.bottom]]
      : [['before', box.left, box.top + box.height / 2],
         ['after', box.right, box.top + box.height / 2]];

    for (const [edge, x, y] of edges) {
      const distance = Math.hypot(x - event.clientX, y - event.clientY);
      if (!best || distance < best.distance) {
        best = { distance, cell, edge, stacked, index: edge === 'before' ? index : index + 1 };
      }
    }
  }
  return best;
}

function clearDropMarkers() {
  for (const cell of els.grid.querySelectorAll('.image-cell')) {
    cell.classList.remove('is-dragging', 'drop-before', 'drop-after', 'is-stacked');
  }
}

/** One listener on the grid rather than one per cell: the gaps belong to it. */
function attachGridReordering() {
  if (els.grid.dataset.reorderReady) return;
  els.grid.dataset.reorderReady = 'true';

  els.grid.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('text/plain')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';

    const gap = gapUnderPointer(event);
    for (const cell of els.grid.querySelectorAll('.image-cell')) {
      cell.classList.remove('drop-before', 'drop-after');
    }
    if (gap) {
      gap.cell.classList.toggle('is-stacked', gap.stacked);
      gap.cell.classList.add(gap.edge === 'before' ? 'drop-before' : 'drop-after');
    }
  });

  els.grid.addEventListener('dragleave', (event) => {
    if (!els.grid.contains(event.relatedTarget)) clearDropMarkers();
  });

  els.grid.addEventListener('drop', (event) => {
    const draggedId = event.dataTransfer.getData('text/plain');
    if (!draggedId) return;
    event.preventDefault();
    event.stopPropagation();

    const gap = gapUnderPointer(event);
    clearDropMarkers();
    if (gap) moveAssetToIndex(draggedId, gap.index);
  });
}

function openImageViewer(asset) {
  const images = listAssets('image');
  openViewer({
    index: Math.max(0, images.findIndex((a) => a.id === asset.id)),
    total: images.length,
    caption: (i) => `${images[i]?.name ?? ''}  ·  ${i + 1} of ${images.length}`,
    placeholder: (i) => fullUrls.get(images[i]?.id) ?? '',
    resolve: async (i) => fullUrls.get(images[i]?.id) ?? '',
  });
}
