// The manual half of the video tools.
//
// Video previews differ from images: re-rendering a clip on every slider move
// would be far too slow, so the grid shows the poster frame with the geometry
// the stack would produce, and the clip itself is rendered on export.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { availableLuts } from '../core/luts.js';
import { plan } from '../core/video.js';
import { openViewer } from './viewer.js';

let els = {};

const scopeOf = (videos) => (videos.length === 1 ? videos[0].name : `${videos.length} videos`);

function queue(type, params, summary) {
  const videos = listAssets('video');
  if (videos.length === 0) return;
  pushOperation({ type, assetIds: videos.map((a) => a.id), params, summary, source: 'user' });
}

export function init(elements) {
  els = elements;

  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'No look';
  els.look.append(none);
  for (const lut of availableLuts()) {
    const option = document.createElement('option');
    option.value = lut.name;
    option.textContent = lut.name;
    option.title = lut.description;
    els.look.append(option);
  }

  els.applyLook.addEventListener('click', () => {
    const look = els.look.value;
    if (!look) return;
    queue(
      'apply_lut',
      { lut_name: look, intensity: 1 },
      `Grade ${scopeOf(listAssets('video'))} with the ${look} look`,
    );
    els.look.value = '';
  });

  els.rotateLeft.addEventListener('click', () =>
    queue('rotate_video', { degrees: 270 }, `Rotate ${scopeOf(listAssets('video'))} by 270°`),
  );
  els.rotateRight.addEventListener('click', () =>
    queue('rotate_video', { degrees: 90 }, `Rotate ${scopeOf(listAssets('video'))} by 90°`),
  );

  els.orientation.addEventListener('change', () => {
    const orientation = els.orientation.value;
    if (!orientation) return;
    queue(
      'set_orientation',
      { orientation },
      `Make ${scopeOf(listAssets('video'))} ${orientation}`,
    );
    els.orientation.value = '';
  });

  els.applyTrim.addEventListener('click', () => {
    const videos = listAssets('video');
    if (videos.length === 0) return;

    const longest = Math.max(...videos.map((a) => a.meta.duration));
    const start = Number(els.trimStart.value) || 0;
    const end = Number(els.trimEnd.value) || longest;
    if (end <= start) {
      window.alert('The end time has to come after the start time.');
      return;
    }
    queue(
      'trim_video',
      { start, end },
      `Trim ${scopeOf(videos)} to ${start}s–${end}s`,
    );
  });
}

export function setThumbSize(px) {
  els.grid.style.setProperty('--thumb-size', `${px}px`);
}

/** Show each clip's poster frame, captioned with what the stack will produce. */
export function refresh(videos) {
  if (videos.length === 0) {
    els.grid.replaceChildren();
    return;
  }

  const wanted = videos.map((a) => a.id).join(',');
  if (els.grid.dataset.assets !== wanted) {
    els.grid.dataset.assets = wanted;
    els.grid.replaceChildren();
    for (const asset of videos) els.grid.append(buildCell(asset));
  }

  for (const asset of videos) {
    const cell = els.grid.querySelector(`[data-asset-id="${asset.id}"]`);
    if (!cell) continue;

    const img = cell.querySelector('img');
    if (img && asset.meta.poster && img.src !== asset.meta.poster) img.src = asset.meta.poster;

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const output = plan(asset.meta, ops);

    // The poster is turned to match, so a queued rotation is visible without
    // waiting for a render.
    if (img) {
      img.style.rotate = `${output.rotation}deg`;
      cell.classList.toggle(
        'is-quarter-turned',
        output.rotation === 90 || output.rotation === 270,
      );
    }

    const caption = cell.querySelector('.image-name');
    if (caption) {
      const trimmed = output.duration < asset.meta.duration - 0.05;
      caption.textContent =
        `${asset.name} · ${output.width}×${output.height} · ` +
        `${output.duration.toFixed(1)}s${trimmed ? ` (of ${asset.meta.duration.toFixed(1)}s)` : ''}`;
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
  if (asset.meta.poster) img.src = asset.meta.poster;
  frame.append(img);

  const badge = document.createElement('span');
  badge.className = 'video-badge';
  badge.textContent = '▶';
  frame.append(badge);

  const zoom = document.createElement('button');
  zoom.className = 'page-zoom';
  zoom.title = `Play ${asset.name}`;
  zoom.setAttribute('aria-label', `Play ${asset.name}`);
  zoom.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  zoom.addEventListener('click', (event) => {
    event.stopPropagation();
    const videos = listAssets('video');
    openViewer({
      index: videos.findIndex((a) => a.id === asset.id),
      total: videos.length,
      caption: (i) => videos[i]?.name ?? '',
      placeholder: (i) => videos[i]?.meta.poster ?? '',
      resolve: async (i) => videos[i]?.meta.poster ?? '',
    });
  });

  const name = document.createElement('span');
  name.className = 'image-name';
  name.textContent = asset.name;

  cell.append(frame, zoom, name);
  return cell;
}
