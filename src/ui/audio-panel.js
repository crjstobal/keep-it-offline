// The manual half of the audio tools, with a waveform so a trim can be aimed
// at something visible rather than guessed from numbers.

import { listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { plan } from '../core/audio.js';

let els = {};

const scopeOf = (tracks) => (tracks.length === 1 ? tracks[0].name : `${tracks.length} tracks`);

function queue(type, params, summary) {
  const tracks = listAssets('audio');
  if (tracks.length === 0) return;
  pushOperation({ type, assetIds: tracks.map((a) => a.id), params, summary, source: 'user' });
}

export function init(elements) {
  els = elements;

  els.speed.addEventListener('input', () => {
    els.speedValue.textContent = `${(Number(els.speed.value) / 100).toFixed(2)}×`;
  });

  els.applySpeed.addEventListener('click', () => {
    const rate = Number(els.speed.value) / 100;
    if (rate === 1) return;
    queue('change_speed', { rate }, `Play ${scopeOf(listAssets('audio'))} at ${rate}×`);
    els.speed.value = '100';
    els.speedValue.textContent = '1.00×';
  });

  els.applyTrim.addEventListener('click', () => {
    const tracks = listAssets('audio');
    if (tracks.length === 0) return;
    const longest = Math.max(...tracks.map((a) => a.meta.duration));
    const start = Number(els.trimStart.value) || 0;
    const end = Number(els.trimEnd.value) || longest;
    if (end <= start) {
      window.alert('The end time has to come after the start time.');
      return;
    }
    queue('trim_audio', { start, end }, `Trim ${scopeOf(tracks)} to ${start}s–${end}s`);
  });
}

export function refresh(tracks) {
  if (tracks.length === 0) {
    els.list.replaceChildren();
    return;
  }

  const wanted = tracks.map((a) => a.id).join(',');
  if (els.list.dataset.assets !== wanted) {
    els.list.dataset.assets = wanted;
    els.list.replaceChildren();
    for (const asset of tracks) els.list.append(buildRow(asset));
  }

  for (const asset of tracks) {
    const row = els.list.querySelector(`[data-asset-id="${asset.id}"]`);
    if (!row) continue;

    const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
    const output = plan(asset.meta, ops);

    const label = row.querySelector('.audio-meta');
    if (label) {
      const changed = Math.abs(output.duration - asset.meta.duration) > 0.05;
      label.textContent =
        `${output.duration.toFixed(1)}s` +
        (changed ? ` (from ${asset.meta.duration.toFixed(1)}s)` : '') +
        ` · ${asset.meta.sampleRate}Hz · ${asset.meta.channels === 1 ? 'mono' : 'stereo'}`;
    }

    // Shade the part the trim would drop, so the cut is visible before export.
    const canvas = row.querySelector('canvas');
    if (canvas && asset.meta.peaks) drawWaveform(canvas, asset.meta.peaks, asset.meta, output);
  }
}

function buildRow(asset) {
  const row = document.createElement('div');
  row.className = 'audio-row';
  row.dataset.assetId = asset.id;

  const name = document.createElement('span');
  name.className = 'audio-name';
  name.textContent = asset.name;

  const canvas = document.createElement('canvas');
  canvas.className = 'audio-wave';
  canvas.width = 900;
  canvas.height = 90;

  const meta = document.createElement('span');
  meta.className = 'audio-meta';

  row.append(name, canvas, meta);
  return row;
}

function drawWaveform(canvas, peaks, meta, output) {
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);

  const startX = (output.start / meta.duration) * width;
  const endX = (output.end / meta.duration) * width;
  const barWidth = width / peaks.length;

  for (const [index, peak] of peaks.entries()) {
    const x = index * barWidth;
    const inRange = x >= startX - barWidth && x <= endX;
    const barHeight = Math.max(1, peak * height * 0.9);

    context.fillStyle = inRange ? '#4ade80' : '#2a2f3a';
    context.fillRect(x, (height - barHeight) / 2, Math.max(1, barWidth - 0.5), barHeight);
  }
}
