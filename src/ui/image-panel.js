// The manual half of the image tools. Same rule as the page grid: these controls
// and the agent's tools push identical operations onto the same stack.
//
// The look and strength controls preview live, the way rotating a PDF page shows
// the result before anything is committed. Applying only fixes what is already
// on screen.

import {
  getState,
  listAssets,
  operationsFor,
  pushOperation,
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

  const scopeOfImages = () => {
    const images = listAssets('image');
    return images.length === 1 ? images[0].name : `${images.length} images`;
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
      assetIds: images.map((a) => a.id),
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
    pushOperation({ type, assetIds: images.map((a) => a.id), params, summary, source: 'user' });
  };

  els.rotateLeft.addEventListener('click', () =>
    queueForAll('rotate_image', { degrees: 270 }, `Rotate ${scopeOfImages()} by 270°`),
  );
  els.rotateRight.addEventListener('click', () =>
    queueForAll('rotate_image', { degrees: 90 }, `Rotate ${scopeOfImages()} by 90°`),
  );
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

  const frame = document.createElement('div');
  frame.className = 'image-frame';

  const img = document.createElement('img');
  img.alt = asset.name;
  frame.append(img);

  // Images get the same enlarged view as PDF pages, for the same reason: you
  // cannot judge a colour grade from a thumbnail.
  const zoom = document.createElement('button');
  zoom.className = 'page-zoom';
  zoom.title = `Enlarge ${asset.name}`;
  zoom.setAttribute('aria-label', `Enlarge ${asset.name}`);
  zoom.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  zoom.addEventListener('click', (event) => {
    event.stopPropagation();
    openImageViewer(asset);
  });

  const name = document.createElement('span');
  name.className = 'image-name';
  name.textContent = asset.name;

  cell.append(frame, zoom, name);
  return cell;
}

function openImageViewer(asset) {
  const images = listAssets('image');
  openViewer({
    index: images.findIndex((a) => a.id === asset.id),
    total: images.length,
    caption: (i) => images[i]?.name ?? '',
    resolve: async (i) => fullUrls.get(images[i]?.id) ?? '',
  });
}
