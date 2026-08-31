// The manual half of the image tools. Same rule as the page grid: these buttons
// and the agent's tools push identical operations onto the same stack.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { availableLuts, ensureLutLoaded } from '../core/luts.js';
import { imageCall } from '../core/worker-bridge.js';

let els = {};
/** Object URLs currently on screen, revoked before being replaced. */
const previewUrls = new Map();

export function init(elements) {
  els = elements;

  for (const lut of availableLuts()) {
    const option = document.createElement('option');
    option.value = lut.name;
    option.textContent = lut.description ? `${lut.name} — ${lut.description}` : lut.name;
    els.lookSelect.append(option);
  }

  els.lookStrength.addEventListener('input', () => {
    els.lookStrengthValue.textContent = `${els.lookStrength.value}%`;
  });

  els.applyLook.addEventListener('click', () => {
    const look = els.lookSelect.value;
    const intensity = Number(els.lookStrength.value) / 100;
    for (const asset of listAssets('image')) {
      pushOperation({
        type: 'apply_lut',
        assetId: asset.id,
        params: { lut_name: look, intensity },
        summary:
          intensity === 1
            ? `Apply the ${look} look`
            : `Apply the ${look} look at ${Math.round(intensity * 100)}%`,
        source: 'user',
      });
    }
  });

  els.applyResize.addEventListener('click', () => {
    const maxWidth = Number(els.resizeWidth.value);
    if (!maxWidth) return;
    for (const asset of listAssets('image')) {
      pushOperation({
        type: 'resize_images',
        assetId: asset.id,
        params: { max_width: maxWidth },
        summary: `Resize to fit ${maxWidth}px wide`,
        source: 'user',
      });
    }
  });

  els.applyFormat.addEventListener('click', () => {
    const format = els.formatSelect.value;
    if (!format) return;
    for (const asset of listAssets('image')) {
      pushOperation({
        type: 'convert_format',
        assetId: asset.id,
        params: { format },
        summary: `Convert to ${format.toUpperCase()}`,
        source: 'user',
      });
    }
  });
}

/**
 * Render the images with the stack applied, so a look queued by either the user
 * or an agent is visible before anything is exported.
 */
export async function refresh(images) {
  if (images.length === 0) {
    els.grid.replaceChildren();
    return;
  }

  // Rebuild only when the set of files changes; otherwise update in place so
  // the images do not flicker on every stack edit.
  const wanted = images.map((a) => a.id).join(',');
  if (els.grid.dataset.assets !== wanted) {
    els.grid.dataset.assets = wanted;
    els.grid.replaceChildren();
    for (const asset of images) {
      const cell = document.createElement('div');
      cell.className = 'image-cell';
      cell.dataset.assetId = asset.id;

      const img = document.createElement('img');
      img.alt = asset.name;

      const name = document.createElement('span');
      name.className = 'image-name';
      name.textContent = asset.name;

      cell.append(img, name);
      els.grid.append(cell);
    }
  }

  for (const asset of images) {
    const cell = els.grid.querySelector(`[data-asset-id="${asset.id}"]`);
    const img = cell?.querySelector('img');
    if (!img) continue;

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));

    try {
      for (const op of ops) {
        if (op.type === 'apply_lut') await ensureLutLoaded(op.params.lut_name);
      }
      // Previews are rendered small: a thumbnail does not need full resolution,
      // and it keeps a live preview cheap enough to redo on every change.
      const result = await imageCall('process', {
        bytes: asset.bytes.slice(0),
        operations: [...ops, { type: 'resize_images', params: { max_width: 320 } }],
        type: asset.meta.type,
      });

      const previous = previewUrls.get(asset.id);
      if (previous) URL.revokeObjectURL(previous);
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.type }));
      previewUrls.set(asset.id, url);
      img.src = url;
    } catch (error) {
      console.error('[keepitoffline] preview failed', asset.name, error);
    }
  }
}
