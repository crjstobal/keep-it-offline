// The manual half of the audio tools.
//
// A trim you cannot hear is a guess, so every track gets a play button and a
// timeline with draggable handles. Playback previews the pending speed change
// too, so what you hear is what the export will produce.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { plan } from '../core/audio.js';
import { createTimeline } from './timeline.js';

let els = {};

/** Per-track playback and timeline state, keyed by asset id. */
const tracks = new Map();

const scopeOf = (list) => (list.length === 1 ? list[0].name : `${list.length} tracks`);

function queue(type, params, summary) {
  const list = listAssets('audio');
  if (list.length === 0) return;
  pushOperation({ type, assetIds: list.map((a) => a.id), params, summary, source: 'user' });
}

export function init(elements) {
  els = elements;

  els.speed.addEventListener('input', () => {
    const rate = Number(els.speed.value) / 100;
    els.speedValue.textContent = `${rate.toFixed(2)}×`;
    // Anything playing follows the slider, so the change can be heard while
    // it is being chosen rather than only after applying.
    for (const entry of tracks.values()) entry.audio.playbackRate = rate;
  });

  els.applySpeed.addEventListener('click', () => {
    const rate = Number(els.speed.value) / 100;
    if (rate === 1) return;
    queue('change_speed', { rate }, `Play ${scopeOf(listAssets('audio'))} at ${rate}×`);
    els.speed.value = '100';
    els.speedValue.textContent = '1.00×';
    for (const entry of tracks.values()) entry.audio.playbackRate = 1;
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

  const trimButton = document.createElement('button');
  trimButton.className = 'ghost';
  trimButton.textContent = 'Trim to selection';

  const zoomOut = document.createElement('button');
  zoomOut.className = 'ghost';
  zoomOut.textContent = 'Fit';
  zoomOut.title = 'Reset zoom (scroll on the waveform to zoom)';

  header.append(play, name, meta, zoomOut, trimButton);

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
      // Dragging the handles is the trim: the numbers follow the picture.
      pending.set(asset.id, { start, end });
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

  tracks.set(asset.id, {
    audio,
    timeline,
    meta,
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
