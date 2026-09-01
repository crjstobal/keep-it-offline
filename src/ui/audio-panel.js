// The manual half of the audio tools.
//
// A trim you cannot hear is a guess, so every track gets a play button and a
// timeline with draggable handles. Playback previews the pending speed change
// too, so what you hear is what the export will produce.

import {
  getState,
  listAssets,
  operationsFor,
  pushOperation,
  removeOperation,
  updateOperation,
} from '../core/workspace.js';
import { plan } from '../core/audio.js';
import { createTimeline } from './timeline.js';

let els = {};

/** Per-track playback and timeline state, keyed by asset id. */
const tracks = new Map();

// Whole-track controls cover the tracks as a set, so the row must not freeze a
// count that a later drop would make wrong.
const scopeOf = (list) => (list.length === 1 ? list[0].name : 'every track');

function queue(type, params, summary) {
  const list = listAssets('audio');
  if (list.length === 0) return;
  pushOperation({ type, scope: 'audio', params, summary, source: 'user' });
}

export function init(elements) {
  els = elements;

  // The slider owns one row on the stack and rewrites it as it moves: dragging
  // through a dozen speeds should leave one change behind, not a dozen.
  let speedOpId = null;

  els.speed.addEventListener('input', () => {
    const rate = Number(els.speed.value) / 100;
    els.speedValue.textContent = `${rate.toFixed(2)}×`;

    // Anything playing follows the slider, so the change is heard as it is chosen.
    for (const entry of tracks.values()) entry.audio.playbackRate = rate;

    const summary = `Play ${scopeOf(listAssets('audio'))} at ${rate}×`;
    if (rate === 1) {
      if (speedOpId) removeOperation(speedOpId);
      speedOpId = null;
      return;
    }
    if (speedOpId && getState().operations.some((op) => op.id === speedOpId)) {
      updateOperation(speedOpId, { params: { rate }, summary });
      return;
    }
    const list = listAssets('audio');
    if (list.length === 0) return;
    speedOpId = pushOperation({
      type: 'change_speed',
      scope: 'audio',
      params: { rate },
      summary,
      source: 'user',
    }).id;
  });
}

export function refresh(list) {
  if (list.length === 0) {
    for (const entry of tracks.values()) entry.destroy();
    tracks.clear();
    els.list.replaceChildren();
    return;
  }

  const wanted = list.map((a) => a.id).join(',');
  if (els.list.dataset.assets !== wanted) {
    els.list.dataset.assets = wanted;
    for (const entry of tracks.values()) entry.destroy();
    tracks.clear();
    els.list.replaceChildren();
    for (const asset of list) els.list.append(buildRow(asset));
  }

  for (const asset of list) {
    const entry = tracks.get(asset.id);
    if (!entry) continue;

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const output = plan(asset.meta, ops);

    entry.timeline.setRange(output.start, output.end);
    entry.times.show(output.start, output.end);
    entry.meta.textContent =
      `${output.duration.toFixed(1)}s` +
      (Math.abs(output.duration - asset.meta.duration) > 0.05
        ? ` (from ${asset.meta.duration.toFixed(1)}s)`
        : '') +
      ` · ${asset.meta.sampleRate}Hz · ${asset.meta.channels === 1 ? 'mono' : 'stereo'}`;
  }
}

function buildRow(asset) {
  const row = document.createElement('div');
  row.className = 'audio-row';
  row.dataset.assetId = asset.id;

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

  const times = buildTimeFields({
    duration: asset.meta.duration,
    onCommit: (start, end) => {
      pending.set(asset.id, { start, end });
      timeline.setRange(start, end);
    },
  });

  const trimButton = document.createElement('button');
  trimButton.className = 'ghost';
  trimButton.textContent = 'Trim to selection';

  const zoomOut = document.createElement('button');
  zoomOut.className = 'ghost';
  zoomOut.textContent = 'Fit';
  zoomOut.title = 'Reset zoom (scroll on the waveform to zoom)';

  header.append(play, name, meta, times.element, zoomOut, trimButton);

  const timelineHost = document.createElement('div');
  timelineHost.className = 'timeline-host';

  row.append(header, timelineHost);

  // The element does the playing: decoding again for preview would be wasteful
  // when the browser can stream the original bytes directly.
  const audio = new Audio();
  audio.src = URL.createObjectURL(new Blob([asset.bytes], { type: asset.meta.type }));
  audio.preload = 'metadata';

  const timeline = createTimeline({
    container: timelineHost,
    duration: asset.meta.duration,
    peaks: () => asset.meta.peaks,
    onChange: (start, end) => {
      // Dragging the handles is the trim, and the boxes follow the picture.
      pending.set(asset.id, { start, end });
      times.show(start, end);
    },
    onScrub: (time) => {
      audio.currentTime = time;
      timeline.setPlayhead(time);
    },
  });

  let raf = 0;
  const follow = () => {
    timeline.setPlayhead(audio.currentTime);
    const range = pending.get(asset.id) ?? timeline.getRange();
    // Stop at the end of the selection, so playback previews the trim.
    if (audio.currentTime >= range.end) {
      audio.pause();
      audio.currentTime = range.start;
    }
    if (!audio.paused) raf = requestAnimationFrame(follow);
  };

  play.addEventListener('click', () => {
    if (audio.paused) {
      const range = pending.get(asset.id) ?? timeline.getRange();
      if (audio.currentTime < range.start || audio.currentTime >= range.end) {
        audio.currentTime = range.start;
      }
      audio.playbackRate = Number(els.speed.value) / 100;
      audio.play();
      play.innerHTML = pauseIcon();
      raf = requestAnimationFrame(follow);
    } else {
      audio.pause();
      play.innerHTML = playIcon();
    }
  });

  audio.addEventListener('pause', () => {
    play.innerHTML = playIcon();
    cancelAnimationFrame(raf);
  });

  zoomOut.addEventListener('click', () => timeline.resetZoom());

  trimButton.addEventListener('click', () => {
    const range = pending.get(asset.id) ?? timeline.getRange();
    const list = listAssets('audio');
    pushOperation({
      type: 'trim_audio',
      assetIds: [asset.id],
      params: { start: range.start, end: range.end },
      summary: `Trim ${asset.name} to ${range.start.toFixed(1)}s–${range.end.toFixed(1)}s`,
      source: 'user',
    });
  });

  times.show(0, asset.meta.duration);

  tracks.set(asset.id, {
    audio,
    timeline,
    meta,
    times,
    destroy() {
      cancelAnimationFrame(raf);
      audio.pause();
      URL.revokeObjectURL(audio.src);
      timeline.destroy();
    },
  });

  return row;
}

/** Handle positions while they are being dragged, before anything is queued. */
const pending = new Map();

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
