// The page grid: how a person does by hand everything an agent can do by tool.
//
// Both paths end in the same place, pushOperation(), so a page removed with the
// mouse and a page removed by an agent are the same kind of thing and undo the
// same way.

import { operationsFor, pushOperation } from '../core/workspace.js';
import { previewPages } from '../core/preview.js';
import { renderFullPage, renderThumbnails } from '../core/thumbnails.js';
import { openViewer as openSharedViewer } from './viewer.js';

/** Pages the user has ticked, as source indices. */
const selection = new Set();

let currentAsset = null;
let thumbs = [];
let onChange = () => {};
/** Anchor for shift-click ranges. */
let lastClickedIndex = null;

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

  const frame = document.createElement('div');
  frame.className = 'page-frame';

  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = `Page ${index + 1}`;
  img.loading = 'lazy';
  frame.append(img);

  const label = document.createElement('span');
  label.className = 'page-number';
  label.textContent = String(index + 1);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'page-check';
  check.setAttribute('aria-label', `Select page ${index + 1}`);
  check.addEventListener('click', (event) => {
    // The cell handles selection; let it see the click once, not twice.
    event.stopPropagation();
    setSelected(cell, index, check.checked);
    lastClickedIndex = index;
  });

  // Zooming lives behind its own button rather than on hover: the pointer
  // crosses dozens of pages on the way anywhere, and a preview that opens by
  // itself every time would be noise.
  const zoom = document.createElement('button');
  zoom.className = 'page-zoom';
  zoom.title = `Enlarge page ${index + 1}`;
  zoom.setAttribute('aria-label', `Enlarge page ${index + 1}`);
  // An inline SVG rather than a glyph: the arrow characters render thin and
  // inconsistently across platforms, and this one has to read at 24px.
  zoom.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  zoom.addEventListener('click', (event) => {
    event.stopPropagation();
    openViewer(index);
  });

  // The whole card is the hit target, which is far easier to hit than a 16px box.
  cell.addEventListener('click', (event) => {
    if (event.shiftKey && lastClickedIndex !== null) {
      selectRange(cell.parentElement, lastClickedIndex, index);
      return;
    }
    setSelected(cell, index, !selection.has(index));
    lastClickedIndex = index;
  });

  cell.append(check, zoom, frame, label);
}

/** Single source of truth for "this page is selected", used by every path. */
function setSelected(cell, index, selected) {
  selected ? selection.add(index) : selection.delete(index);
  cell.classList.toggle('is-selected', selected);
  const check = cell.querySelector('.page-check');
  if (check) check.checked = selected;
  onChange(selection.size);
}

/** Shift-click: select everything between the last click and this one. */
function selectRange(grid, from, to) {
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (let i = start; i <= end; i++) {
    const cell = grid.children[i];
    if (cell) setSelected(cell, i, true);
  }
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

    const rotation = kept.get(index) ?? 0;
    const img = cell.querySelector('img');
    if (!img) continue;

    img.style.rotate = `${rotation}deg`;
    // At a quarter turn the page is wider than it is tall, so the frame has to
    // swap its proportions too. Without this the image keeps its upright
    // footprint and spills over the neighbouring cells.
    const quarterTurned = rotation === 90 || rotation === 270;
    cell.classList.toggle('is-quarter-turned', quarterTurned);
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
    assetIds: currentAsset.id,
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
    assetIds: currentAsset.id,
    params: { pages, degrees: deg },
    summary: `Rotate ${pages.length} page${pages.length === 1 ? '' : 's'} by ${deg}°`,
    source: 'user',
  });
  // The selection survives a rotation on purpose: turning the same pages twice
  // to reach 180°, or rotating and then removing them, are both common.
  // Removal is the exception, since those pages are gone from the document.
}

/**
 * Bulk selection. 'even' and 'odd' go by page number, not index, because that
 * is what "remove the even pages" means to a person.
 *
 * @param {'all' | 'even' | 'odd'} mode
 */
export function selectPages(container, mode) {
  if (!currentAsset) return;
  selection.clear();
  for (const cell of container.querySelectorAll('.page-cell')) {
    const index = Number(cell.dataset.index);
    const pageNumber = index + 1;
    const wanted =
      mode === 'all' ? true : mode === 'even' ? pageNumber % 2 === 0 : pageNumber % 2 === 1;
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

// --- Enlarged viewer -------------------------------------------------------

/** Open the shared viewer over this document's pages. */
export function openViewer(index) {
  if (!currentAsset) return;
  const asset = currentAsset;
  openSharedViewer({
    index,
    total: asset.meta.pageCount,
    caption: (i) => `Page ${i + 1} of ${asset.meta.pageCount}`,
    rotation: (i) => rotationFor(i),
    placeholder: (i) => thumbs[i] ?? '',
    resolve: (i) => renderFullPage(asset.id, asset.bytes, i),
  });
}

/** Rotation the stack currently applies to a source page, for the viewer. */
function rotationFor(sourceIndex) {
  if (!currentAsset) return 0;
  const ops = operationsFor(currentAsset.id).map((op) => ({ type: op.type, params: op.params }));
  const page = previewPages(currentAsset.meta.pageCount, ops).find(
    (p) => p.sourceIndex === sourceIndex,
  );
  return page?.rotation ?? 0;
}
