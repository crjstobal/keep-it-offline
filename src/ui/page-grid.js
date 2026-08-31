// The page grid: how a person does by hand everything an agent can do by tool.
//
// Both paths end in the same place, pushOperation(), so a page removed with the
// mouse and a page removed by an agent are the same kind of thing and undo the
// same way.

import { operationsFor, pushOperation } from '../core/workspace.js';
import { previewPages } from '../core/preview.js';
import { renderThumbnails } from '../core/thumbnails.js';

/** Pages the user has ticked, as source indices. */
const selection = new Set();

let currentAsset = null;
let thumbs = [];
let onChange = () => {};

export function init({ container, onSelectionChange }) {
  currentAsset = null;
  onChange = onSelectionChange ?? (() => {});
  return { container };
}

export async function showAsset(asset, container) {
  currentAsset = asset;
  selection.clear();
  thumbs = [];
  onChange(0);

  if (!asset || asset.kind !== 'pdf') {
    container.replaceChildren();
    return;
  }

  container.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'page-grid';
  container.append(grid);

  // Placeholders first, filled in as each page renders, so a long document
  // shows its shape immediately instead of a blank area.
  await renderThumbnails(asset.id, asset.bytes, (index, total, dataUrl) => {
    thumbs[index] = dataUrl;
    if (grid.children.length === 0) {
      for (let i = 0; i < total; i++) grid.append(makePlaceholder(i));
    }
    const cell = grid.children[index];
    if (cell) fillCell(cell, index, dataUrl);
  });

  refresh(container);
}

function makePlaceholder(index) {
  const cell = document.createElement('div');
  cell.className = 'page-cell is-loading';
  cell.dataset.index = String(index);
  return cell;
}

function fillCell(cell, index, dataUrl) {
  cell.classList.remove('is-loading');
  cell.replaceChildren();

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = `Page ${index + 1}`;
  img.loading = 'lazy';

  const label = document.createElement('span');
  label.className = 'page-number';
  label.textContent = String(index + 1);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'page-check';
  check.setAttribute('aria-label', `Select page ${index + 1}`);
  check.addEventListener('change', () => {
    check.checked ? selection.add(index) : selection.delete(index);
    cell.classList.toggle('is-selected', check.checked);
    onChange(selection.size);
  });

  cell.append(check, img, label);
}

/** Grey out pages the enabled operations would remove, and apply rotations. */
export function refresh(container) {
  if (!currentAsset) return;
  const grid = container.querySelector('.page-grid');
  if (!grid) return;

  const ops = operationsFor(currentAsset.id).map((op) => ({ type: op.type, params: op.params }));
  const surviving = previewPages(currentAsset.meta.pageCount, ops);
  const kept = new Map(surviving.map((p) => [p.sourceIndex, p.rotation]));

  for (const cell of grid.children) {
    const index = Number(cell.dataset.index);
    const isKept = kept.has(index);
    cell.classList.toggle('is-removed', !isKept);
    const img = cell.querySelector('img');
    if (img) img.style.rotate = `${kept.get(index) ?? 0}deg`;
  }
}

export function getSelection() {
  return [...selection].sort((a, b) => a - b);
}

export function clearSelection(container) {
  selection.clear();
  for (const check of container.querySelectorAll('.page-check')) check.checked = false;
  for (const cell of container.querySelectorAll('.page-cell')) cell.classList.remove('is-selected');
  onChange(0);
}

/** Queue removal of the selected pages, exactly as the tool would. */
export function removeSelected(container) {
  if (!currentAsset || selection.size === 0) return;
  const pages = getSelection();

  const ops = operationsFor(currentAsset.id).map((op) => ({ type: op.type, params: op.params }));
  const remaining = previewPages(currentAsset.meta.pageCount, [
    ...ops,
    { type: 'remove_pages', params: { pages } },
  ]);
  if (remaining.length === 0) {
    window.alert('A PDF has to keep at least one page.');
    return;
  }

  pushOperation({
    type: 'remove_pages',
    assetId: currentAsset.id,
    params: { pages },
    summary: `Remove ${pages.length} page${pages.length === 1 ? '' : 's'}: ${pages.map((i) => i + 1).join(', ')}`,
    source: 'user',
  });
  clearSelection(container);
}

/** Queue a rotation of the selected pages. */
export function rotateSelected(container, deg) {
  if (!currentAsset || selection.size === 0) return;
  const pages = getSelection();
  pushOperation({
    type: 'rotate_pages',
    assetId: currentAsset.id,
    params: { pages, degrees: deg },
    summary: `Rotate ${pages.length} page${pages.length === 1 ? '' : 's'} by ${deg}°`,
    source: 'user',
  });
  clearSelection(container);
}

/** Select every page whose number matches a parity, for "remove the even pages". */
export function selectByParity(container, parity) {
  if (!currentAsset) return;
  selection.clear();
  for (const cell of container.querySelectorAll('.page-cell')) {
    const index = Number(cell.dataset.index);
    const pageNumber = index + 1;
    const wanted = parity === 'even' ? pageNumber % 2 === 0 : pageNumber % 2 === 1;
    const check = cell.querySelector('.page-check');
    if (check) check.checked = wanted;
    cell.classList.toggle('is-selected', wanted);
    if (wanted) selection.add(index);
  }
  onChange(selection.size);
}

export function getCurrentAsset() {
  return currentAsset;
}
