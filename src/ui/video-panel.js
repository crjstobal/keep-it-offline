// The manual half of the video tools.
//
// The clip plays into a canvas rather than a plain <video>, which is what lets
// the preview show the pending grade, rotation and trim as they are chosen. A
// poster frame alone could not: it would still be the ungraded original, which
// looked exactly like the grade being broken.

import {
  describeTarget,
  getState,
  isSelected,
  listAssets,
  operationsFor,
  pushOperation,
  removeAsset,
  removeOperation,
  targetFor,
  toggleSelected,
  updateOperation,
} from '../core/workspace.js';
import { availableLuts, ensureLutLoaded, lutFor } from '../core/luts.js';
import { applyLutToPixels } from '../core/lut-math.js';
import { plan } from '../core/video.js';
import { createTimeline } from './timeline.js';

let els = {};

/** Per-clip playback state, keyed by asset id. */
const clips = new Map();

// Whole-clip controls cover the videos as a set unless clips have been picked
// out, so the row must not freeze a count that a later drop would make wrong.
const CLIP_WORDS = { one: 'clip', many: 'clips', all: 'every clip' };
const scopeOfClips = (target = targetFor('video')) => describeTarget(target, CLIP_WORDS);

/** Which clips a row was pushed for, so a changed selection starts a new one. */
const targetKey = (target) => (target.scope ? 'all' : target.assetIds.join(','));

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

  // Choosing a look is the decision, so it goes onto the stack at once and the
  // preview follows from there. Setting it back to none takes the row away.
  let lookOpId = null;
  els.look.addEventListener('change', async () => {
    const look = els.look.value;

    if (lookOpId) {
      removeOperation(lookOpId);
      lookOpId = null;
    }
    if (look) {
      const target = targetFor('video');
      if (target.assets.length === 0) return;
      await ensureLutLoaded(look).catch(() => {});
      const op = pushOperation({
        type: 'apply_lut',
        scope: target.scope,
        assetIds: target.assetIds,
        params: { lut_name: look, intensity: Number(els.strength.value) / 100 },
        summary: `Grade ${scopeOfClips()} with the ${look} look`,
        source: 'user',
      });
      lookOpId = op.id;
    }
    for (const entry of clips.values()) entry.drawCurrentFrame();
  });

  els.strength.addEventListener('input', () => {
    const percent = Number(els.strength.value);
    els.strengthValue.textContent = `${percent}%`;
    if (!lookOpId) return;
    const look = els.look.value;
    // The row keeps whichever clips it was pushed for: the slider changes how
    // strong the grade is, not who gets it.
    const op = getState().operations.find((o) => o.id === lookOpId);
    if (!op) return;
    const named = scopeOfClips(op);
    updateOperation(lookOpId, {
      params: { intensity: percent / 100 },
      summary:
        percent === 100
          ? `Grade ${named} with the ${look} look`
          : `Grade ${named} with the ${look} look at ${percent}%`,
    });
    for (const entry of clips.values()) entry.drawCurrentFrame();
  });

  /**
   * Rotation folds, as it does for stills: two lefts are a half turn, and
   * turning back to square takes the change away.
   */
  let rotationOpId = null;
  let rotationTarget = null;
  const turn = (delta) => {
    const target = targetFor('video');
    if (target.assets.length === 0) return;

    // Folding only applies while the turns are about the same clips.
    const wanted = targetKey(target);
    const existing =
      rotationTarget === wanted
        ? getState().operations.find((op) => op.id === rotationOpId)
        : undefined;
    const total = (((existing?.params.degrees ?? 0) + delta) % 360 + 360) % 360;

    if (total === 0) {
      if (existing) removeOperation(existing.id);
      rotationOpId = null;
      rotationTarget = null;
      return;
    }
    const summary = `Rotate ${scopeOfClips(target)} by ${total}°`;
    if (existing) {
      updateOperation(existing.id, { params: { degrees: total }, summary });
      return;
    }
    rotationOpId = pushOperation({
      type: 'rotate_video',
      scope: target.scope,
      assetIds: target.assetIds,
      params: { degrees: total },
      summary,
      source: 'user',
    }).id;
    rotationTarget = wanted;
  };

  els.rotateLeft.addEventListener('click', () => turn(-90));
  els.rotateRight.addEventListener('click', () => turn(90));
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

    const cell = els.grid.querySelector(`[data-asset-id="${asset.id}"]`);
    const picked = isSelected(asset.id);
    cell?.classList.toggle('is-picked', picked);
    const tick = cell?.querySelector('.cell-tick');
    if (tick) {
      tick.setAttribute('aria-pressed', String(picked));
      tick.title = picked ? `Deselect ${asset.name}` : `Select ${asset.name}`;
      tick.setAttribute('aria-label', tick.title);
    }

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const output = plan(asset.meta, ops);

    entry.timeline.setRange(output.start, output.end);
    entry.times.show(output.start, output.end);
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

  // The same tick a photograph carries. The picture is not the hit area here:
  // clicking a clip is how you scrub it, so only the tick selects.
  const tick = document.createElement('button');
  tick.className = 'cell-tick';
  tick.type = 'button';
  tick.innerHTML =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" ' +
    'stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 12.5 9.5 18 20 6.5"/></svg>';
  tick.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleSelected(asset.id);
  });
  stage.append(tick);

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

  // The same two controls a photograph carries: look at it, or take it off.
  const cellActions = document.createElement('div');
  cellActions.className = 'cell-actions';

  const enlarge = document.createElement('button');
  enlarge.className = 'cell-button';
  enlarge.type = 'button';
  enlarge.title = `View ${asset.name}`;
  enlarge.setAttribute('aria-label', `View ${asset.name}`);
  enlarge.innerHTML =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  enlarge.addEventListener('click', (event) => {
    event.stopPropagation();
    const list = listAssets('video');
    openViewer({
      index: Math.max(0, list.findIndex((a) => a.id === asset.id)),
      total: list.length,
      caption: (i) => `${list[i]?.name ?? ''}  ·  ${i + 1} of ${list.length}`,
      placeholder: (i) => list[i]?.meta.poster ?? '',
      resolve: async (i) => list[i]?.meta.poster ?? '',
    });
  });

  const removeClip = document.createElement('button');
  removeClip.className = 'cell-button cell-remove';
  removeClip.type = 'button';
  removeClip.title = `Remove ${asset.name}`;
  removeClip.setAttribute('aria-label', `Remove ${asset.name}`);
  removeClip.textContent = '×';
  removeClip.addEventListener('click', (event) => {
    event.stopPropagation();
    const queued = operationsFor(asset.id).length;
    const warning = queued
      ? `Remove ${asset.name}? It has ${queued} change${queued === 1 ? '' : 's'} that will go with it.`
      : `Remove ${asset.name} from the bench?`;
    if (window.confirm(warning)) removeAsset(asset.id);
  });

  cellActions.append(enlarge, removeClip);
  stage.append(cellActions);

  const times = buildTimeFields({
    duration: asset.meta.duration,
    onCommit: (start, end) => {
      pending.set(asset.id, { start, end });
      timeline.setRange(start, end);
      video.currentTime = start;
      commitTrim(asset, start, end);
    },
  });

  header.append(play, name, meta, times.element, fit);

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
    const lookName = queued?.params.lut_name;
    if (!lookName) return;

    try {
      const lut = await lutFor(lookName);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      applyLutToPixels(image.data, lut, queued?.params.intensity ?? 1);
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
      times.show(start, end);
      commitTrim(asset, start, end);
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

  times.show(0, asset.meta.duration);

  clips.set(asset.id, {
    video,
    timeline,
    meta,
    times,
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

/**
 * A trim, committed as it is made.
 *
 * Dragging a handle *is* the instruction, so it goes onto the stack at once and
 * the stack is where it is seen and undone. A "Trim to selection" button in
 * between only asked people to confirm what they had just said with their
 * hands, and every other control here already works this way.
 *
 * A drag fires continuously, so each clip keeps one row and rewrites it as the
 * handles move: one change, one undo, wherever the pointer ended up. Pulling
 * the handles back to the full length is not a trim at all, and takes the row
 * away again.
 */
const trimRows = new Map();
function commitTrim(asset, start, end) {
  const full = start <= 0.001 && end >= asset.meta.duration - 0.001;
  const existing = trimRows.get(asset.id);
  const live = existing && getState().operations.some((op) => op.id === existing);

  if (full) {
    if (live) removeOperation(existing);
    trimRows.delete(asset.id);
    return;
  }

  const params = { start, end };
  const summary = `Trim ${asset.name} to ${start.toFixed(1)}s–${end.toFixed(1)}s`;
  if (live) {
    updateOperation(existing, { params, summary });
    return;
  }
  trimRows.set(
    asset.id,
    pushOperation({
      type: 'trim_video',
      assetIds: [asset.id],
      params,
      summary,
      source: 'user',
    }).id,
  );
}

const playIcon = () =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M8 5v14l11-7z"/></svg>';

const pauseIcon = () =>
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
  '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

/**
 * The start and end boxes that sit beside a timeline.
 *
 * Dragging is how you find a cut; typing is how you say exactly where it goes,
 * and seeing the numbers is how you check the handles landed where you meant.
 * Both directions stay in step: dragging updates the boxes, typing moves the
 * handles.
 */
function buildTimeFields({ duration, onCommit }) {
  const wrap = document.createElement('span');
  wrap.className = 'time-fields';

  const make = (label) => {
    const field = document.createElement('label');
    field.className = 'field';
    const text = document.createElement('span');
    text.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(duration.toFixed(2));
    input.step = '0.1';
    input.className = 'time-input';
    field.append(text, input);
    return { field, input };
  };

  const from = make('From');
  const to = make('To');
  const unit = document.createElement('span');
  unit.className = 'hint-inline';
  unit.textContent = 's';

  wrap.append(from.field, to.field, unit);

  const clampAndCommit = () => {
    let start = Number(from.input.value);
    let end = Number(to.input.value);
    if (!Number.isFinite(start)) start = 0;
    if (!Number.isFinite(end)) end = duration;

    start = Math.min(Math.max(0, start), duration - 0.1);
    end = Math.min(Math.max(start + 0.1, end), duration);

    from.input.value = start.toFixed(2);
    to.input.value = end.toFixed(2);
    onCommit(start, end);
  };

  for (const input of [from.input, to.input]) {
    input.addEventListener('change', clampAndCommit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        clampAndCommit();
      }
    });
  }

  return {
    element: wrap,
    /** Reflect a drag without firing onCommit back at the timeline. */
    show(start, end) {
      if (document.activeElement !== from.input) from.input.value = start.toFixed(2);
      if (document.activeElement !== to.input) to.input.value = end.toFixed(2);
    },
  };
}
