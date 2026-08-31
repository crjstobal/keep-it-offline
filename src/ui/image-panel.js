// The manual half of the image tools. Same rule as the page grid: these controls
// and the agent's tools push identical operations onto the same stack.
//
// The look and strength controls preview live, the way rotating a PDF page shows
// the result before anything is committed. Applying only fixes what is already
// on screen.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { availableLuts, ensureLutLoaded } from '../core/luts.js';
import { imageCall } from '../core/worker-bridge.js';
import { openViewer } from './viewer.js';

let els = {};
/** Object URLs currently on screen, revoked before being replaced. */
const previewUrls = new Map();
/** Full-resolution renders for the enlarged viewer, keyed by asset id. */
const fullUrls = new Map();

/** What the controls currently propose, applied to previews but not committed. */
let draft = { look: '', intensity: 1 };
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

  els.lookSelect.addEventListener('change', () => {
    draft.look = els.lookSelect.value;
    els.applyLook.disabled = !draft.look;
    schedulePreview();
  });

  els.lookStrength.addEventListener('input', () => {
    draft.intensity = Number(els.lookStrength.value) / 100;
    els.lookStrengthValue.textContent = `${els.lookStrength.value}%`;
    schedulePreview();
  });

  els.applyLook.addEventListener('click', () => {
    if (!draft.look) return;
    const images = listAssets('image');
    const scope = images.length === 1 ? images[0].name : `${images.length} images`;
    const percent = Math.round(draft.intensity * 100);

    pushOperation({
      type: 'apply_lut',
      assetIds: images.map((a) => a.id),
      params: { lut_name: draft.look, intensity: draft.intensity },
      summary:
        draft.intensity === 1
          ? `Apply the ${draft.look} look to ${scope}`
          : `Apply the ${draft.look} look at ${percent}% to ${scope}`,
      source: 'user',
    });

    // The look is committed, so the draft goes back to neutral: leaving it set
    // would show it twice, once queued and once as a pending preview. Looks
    // still stack, so choosing another one adds a second step.
    resetDraft();
  });

  els.applyResize.addEventListener('click', () => {
    const maxWidth = Number(els.resizeWidth.value);
    if (!maxWidth) return;
    const images = listAssets('image');
    pushOperation({
      type: 'resize_images',
      assetIds: images.map((a) => a.id),
      params: { max_width: maxWidth },
      summary:
        images.length === 1
          ? `Resize ${images[0].name} to fit ${maxWidth}px wide`
          : `Resize ${images.length} images to fit ${maxWidth}px wide`,
      source: 'user',
    });
  });

  els.applyFormat.addEventListener('click', () => {
    const format = els.formatSelect.value;
    if (!format) return;
    const images = listAssets('image');
    pushOperation({
      type: 'convert_format',
      assetIds: images.map((a) => a.id),
      params: { format },
      summary:
        images.length === 1
          ? `Convert ${images[0].name} to ${format.toUpperCase()}`
          : `Convert ${images.length} images to ${format.toUpperCase()}`,
      source: 'user',
    });
  });

  const scopeOfImages = () => {
    const images = listAssets('image');
    return images.length === 1 ? images[0].name : `${images.length} images`;
  };

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

  els.applyLook.disabled = true;
}

function resetDraft() {
  draft = { look: '', intensity: 1 };
  els.lookSelect.value = '';
  els.lookStrength.value = '100';
  els.lookStrengthValue.textContent = '100%';
  els.applyLook.disabled = true;
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

/** The operations to preview: what is committed, plus what the controls propose. */
function previewOperations(assetId) {
  const committed = operationsFor(assetId).map((op) => ({ type: op.type, params: op.params }));
  if (!draft.look) return committed;
  return [
    ...committed,
    { type: 'apply_lut', params: { lut_name: draft.look, intensity: draft.intensity } },
  ];
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
