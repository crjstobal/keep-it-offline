// The manual half of the video tools.
//
// The clip plays into a canvas rather than a plain <video>, which is what lets
// the preview show the pending grade, rotation and trim as they are chosen. A
// poster frame alone could not: it would still be the ungraded original, which
// looked exactly like the grade being broken.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { availableLuts, ensureLutLoaded, lutFor } from '../core/luts.js';
import { applyLutToPixels } from '../core/lut-math.js';
import { plan } from '../core/video.js';
import { createTimeline } from './timeline.js';

let els = {};

/** Per-clip playback state, keyed by asset id. */
const clips = new Map();

/** The look the controls propose but have not committed. */
let draftLook = '';

const scopeOf = (list) => (list.length === 1 ? list[0].name : `${list.length} videos`);

function queue(type, params, summary) {
  const list = listAssets('video');
  if (list.length === 0) return;
  pushOperation({ type, assetIds: list.map((a) => a.id), params, summary, source: 'user' });
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

  // Choosing a look previews it immediately, as it does for stills.
  els.look.addEventListener('change', async () => {
    draftLook = els.look.value;
    if (draftLook) await ensureLutLoaded(draftLook).catch(() => {});
    for (const entry of clips.values()) entry.drawCurrentFrame();
  });

  els.applyLook.addEventListener('click', () => {
    if (!draftLook) return;
    queue(
      'apply_lut',
      { lut_name: draftLook, intensity: 1 },
      `Grade ${scopeOf(listAssets('video'))} with the ${draftLook} look`,
    );
    draftLook = '';
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
    queue('set_orientation', { orientation }, `Make ${scopeOf(listAssets('video'))} ${orientation}`);
    els.orientation.value = '';
  });
}

export function setThumbSize(px) {
  els.grid.style.setProperty('--thumb-size', `${px}px`);
}

export function refresh(list) {
  if (list.length === 0) {
    for (const entry of clips.values()) entry.destroy();
    clips.clear();
    els.grid.replaceChildren();
    return;
  }

  const wanted = list.map((a) => a.id).join(',');
  if (els.grid.dataset.assets !== wanted) {
    els.grid.dataset.assets = wanted;
    for (const entry of clips.values()) entry.destroy();
    clips.clear();
    els.grid.replaceChildren();
    for (const asset of list) els.grid.append(buildCell(asset));
  }

  for (const asset of list) {
    const entry = clips.get(asset.id);
    if (!entry) continue;

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const output = plan(asset.meta, ops);

    entry.timeline.setRange(output.start, output.end);
    entry.meta.textContent =
      `${output.width}×${output.height} · ${output.duration.toFixed(1)}s` +
      (output.duration < asset.meta.duration - 0.05
        ? ` (of ${asset.meta.duration.toFixed(1)}s)`
        : '');
    entry.drawCurrentFrame();
  }
}

function buildCell(asset) {
  const cell = document.createElement('div');
  cell.className = 'video-cell';
  cell.dataset.assetId = asset.id;

  const stage = document.createElement('div');
  stage.className = 'video-stage';

  // A canvas, not a <video>: the pending grade has to be visible before export.
  const canvas = document.createElement('canvas');
  canvas.className = 'video-canvas';
  stage.append(canvas);

  const header = document.createElement('div');
  header.className = 'audio-header';

  const play = document.createElement('button');
  play.className = 'ghost play-button';
  play.setAttribute('aria-label', `Play ${asset.name}`);
  play.innerHTML = playIcon();

  const name = document.createElement('span');
  name.className = 'audio-name';
  name.textContent = asset.name;

  const meta = document.createElement('span');
  meta.className = 'audio-meta';

  const fit = document.createElement('button');
  fit.className = 'ghost';
  fit.textContent = 'Fit';
  fit.title = 'Reset zoom (scroll on the timeline to zoom)';

  const trimButton = document.createElement('button');
  trimButton.className = 'ghost';
  trimButton.textContent = 'Trim to selection';

  header.append(play, name, meta, fit, trimButton);

  const timelineHost = document.createElement('div');
  timelineHost.className = 'timeline-host';

  cell.append(stage, header, timelineHost);

  const video = document.createElement('video');
  video.src = URL.createObjectURL(new Blob([asset.bytes], { type: asset.meta.type }));
  video.muted = true;
  video.preload = 'metadata';

  const context = canvas.getContext('2d', { willReadFrequently: true });

  /** Draw the frame at the current time, with the stack and draft applied. */
  async function drawCurrentFrame() {
    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const layout = plan(asset.meta, ops);

    // Preview at a sensible size: full resolution would cost far more than it
    // shows in a grid cell.
    const scale = Math.min(1, 640 / Math.max(layout.width, layout.height));
    canvas.width = Math.max(2, Math.round(layout.width * scale));
    canvas.height = Math.max(2, Math.round(layout.height * scale));

    if (video.readyState < 2) return;

    context.save();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    if (layout.rotation) context.rotate((layout.rotation * Math.PI) / 180);

    const quarter = layout.rotation === 90 || layout.rotation === 270;
    const boxWidth = quarter ? canvas.height : canvas.width;
    const boxHeight = quarter ? canvas.width : canvas.height;
    const fitScale = Math.min(boxWidth / video.videoWidth, boxHeight / video.videoHeight);
    const drawWidth = video.videoWidth * fitScale;
    const drawHeight = video.videoHeight * fitScale;
    context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();

    // The grade: whatever is queued, plus whatever the control proposes.
    const queued = ops.find((op) => op.type === 'apply_lut');
    const lookName = draftLook || queued?.params.lut_name;
    if (!lookName) return;

    try {
      const lut = await lutFor(lookName);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      applyLutToPixels(image.data, lut, draftLook ? 1 : queued?.params.intensity ?? 1);
      context.putImageData(image, 0, 0);
    } catch (error) {
      console.error('[keepitoffline] could not preview the grade', error);
    }
  }

  const timeline = createTimeline({
    container: timelineHost,
    duration: asset.meta.duration,
    onChange: (start, end) => {
      pending.set(asset.id, { start, end });
    },
    onScrub: (time) => {
      video.currentTime = time;
    },
  });

  let raf = 0;
  const follow = () => {
    timeline.setPlayhead(video.currentTime);
    drawCurrentFrame();
    const range = pending.get(asset.id) ?? timeline.getRange();
    if (video.currentTime >= range.end) {
      video.pause();
      video.currentTime = range.start;
    }
    if (!video.paused) raf = requestAnimationFrame(follow);
  };

  video.addEventListener('loadeddata', () => {
    video.currentTime = Math.min(0.1, asset.meta.duration / 4);
  });
  video.addEventListener('seeked', () => {
    drawCurrentFrame();
    timeline.setPlayhead(video.currentTime);
  });

  play.addEventListener('click', () => {
    if (video.paused) {
      const range = pending.get(asset.id) ?? timeline.getRange();
      if (video.currentTime < range.start || video.currentTime >= range.end) {
        video.currentTime = range.start;
      }
      video.play();
      play.innerHTML = pauseIcon();
      raf = requestAnimationFrame(follow);
    } else {
      video.pause();
      play.innerHTML = playIcon();
    }
  });

  video.addEventListener('pause', () => {
    play.innerHTML = playIcon();
    cancelAnimationFrame(raf);
  });

  fit.addEventListener('click', () => timeline.resetZoom());

  trimButton.addEventListener('click', () => {
    const range = pending.get(asset.id) ?? timeline.getRange();
    pushOperation({
      type: 'trim_video',
      assetIds: [asset.id],
      params: { start: range.start, end: range.end },
      summary: `Trim ${asset.name} to ${range.start.toFixed(1)}s–${range.end.toFixed(1)}s`,
      source: 'user',
    });
  });

  clips.set(asset.id, {
    video,
    timeline,
    meta,
    drawCurrentFrame,
    destroy() {
      cancelAnimationFrame(raf);
      video.pause();
      URL.revokeObjectURL(video.src);
      timeline.destroy();
    },
  });

  return cell;
}

/** Handle positions while they are being dragged, before anything is queued. */
const pending = new Map();

const playIcon = () =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M8 5v14l11-7z"/></svg>';

const pauseIcon = () =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
