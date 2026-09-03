// The page grid: how a person does by hand everything an agent can do by tool.
//
// Both paths end in the same place, pushOperation(), so a page removed with the
// mouse and a page removed by an agent are the same kind of thing and undo the
// same way.
//
// Every loaded PDF is on screen at once, each in its own group. Two documents
// look like two documents, because that is what they are and because a page
// number means nothing until you know which file it belongs to. Drag a page
// across the boundary and the two become one: the distinction was never the
// point, it was only ever a description of what was on the bench.

import { getAsset, listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { previewPages } from '../core/preview.js';
import { renderFullPage, renderThumbnails } from '../core/thumbnails.js';
import { openViewer as openSharedViewer } from './viewer.js';

/**
 * Pages the user has ticked, as "assetId:sourceIndex".
 *
 * Keyed by document because page 3 of one file and page 3 of another are
 * different pages, and with both grids on screen a person can tick either.
 */
const selection = new Set();

/** @type {Map<string, string[]>} assetId -> thumbnails, indexed by source page */
const thumbs = new Map();

/** Which documents are currently drawn, in bench order. */
let shownIds = [];
/**
 * The render in progress.
 *
 * Thumbnails arrive over many frames, and the workspace can change while they
 * do: an agent queues an operation, a file is dropped, a merge lands. Each run
 * takes a token and checks it before touching the DOM, so a superseded render
 * stops instead of filling in a grid that has already been thrown away.
 */
let renderToken = 0;
let onChange = () => {};
/** Anchor for shift-click ranges, within one document. */
let lastClicked = null;

const key = (assetId, index) => `${assetId}:${index}`;

export function init({ container, onSelectionChange }) {
  shownIds = [];
  onChange = onSelectionChange ?? (() => {});
  return { container };
}

/**
 * Draw every loaded PDF, one group each.
 *
 * Groups are rebuilt only when the set of documents changes: rendering
 * thumbnails is the expensive part of this page, and a queued operation must
 * not cost a re-render of forty pages.
 */
export async function showAssets(container) {
  const pdfs = listAssets('pdf');
  const ids = pdfs.map((a) => a.id);

  if (ids.length === shownIds.length && ids.every((id, i) => id === shownIds[i])) {
    refresh(container);
    return;
  }

  // Ticks on a document that has left the bench cannot survive it.
  const live = new Set(ids);
  for (const entry of [...selection]) {
    if (!live.has(entry.slice(0, entry.lastIndexOf(':')))) selection.delete(entry);
  }
  shownIds = ids;
  onChange(selection.size);

  const token = ++renderToken;
  container.replaceChildren();
  if (pdfs.length === 0) return;

  // The groups are built up front so a slow second document does not leave a
  // gap where its heading should be.
  const groups = new Map();
  for (const asset of pdfs) {
    const group = makeGroup(asset, pdfs.length > 1);
    groups.set(asset.id, group);
    container.append(group.root);
  }

  for (const asset of pdfs) {
    const { grid } = groups.get(asset.id);
    const cached = thumbs.get(asset.id) ?? [];
    thumbs.set(asset.id, cached);

    await renderThumbnails(asset.id, asset.bytes, (index, total, dataUrl) => {
      cached[index] = dataUrl;
      if (token !== renderToken) return;

      if (grid.children.length === 0) {
        for (let i = 0; i < total; i++) grid.append(makePlaceholder(asset.id, i));
      }
      // The cells may already have been put in the order the stack leaves them,
      // so a page is found by the source index it carries rather than by where
      // it happens to sit.
      const cell = grid.querySelector(`.page-cell[data-index="${index}"]`);
      if (cell) fillCell(cell, asset, index, dataUrl);
    });
    if (token !== renderToken) return;
  }

  refresh(container);
}

/**
 * One document's heading and grid.
 *
 * With a single PDF on the bench the heading is left off: there is nothing to
 * tell apart, and a label over the only thing on screen is noise. It appears
 * the moment a second document arrives, which is also the moment the colour
 * band along the edge starts meaning something.
 */
function makeGroup(asset, labelled) {
  const root = document.createElement('section');
  root.className = 'page-group';
  root.dataset.assetId = asset.id;
  // The band is coloured by position rather than by id, so the first document
  // is always the first colour however many have come and gone.
  root.dataset.band = String(shownIds.indexOf(asset.id) % 4);

  if (labelled) {
    const heading = document.createElement('div');
    heading.className = 'page-group-head';

    const name = document.createElement('span');
    name.className = 'page-group-name';
    name.textContent = asset.name;

    const count = document.createElement('span');
    count.className = 'page-group-count';
    count.textContent = `${asset.meta.pageCount} page${asset.meta.pageCount === 1 ? '' : 's'}`;

    heading.append(name, count);
    root.append(heading);
  }

  const grid = document.createElement('div');
  grid.className = 'page-grid';
  grid.dataset.assetId = asset.id;
  root.append(grid);
  attachGridReordering(grid);

  return { root, grid };
}

function makePlaceholder(assetId, index) {
  const cell = document.createElement('div');
  cell.className = 'page-cell is-loading';
  cell.dataset.index = String(index);
  cell.dataset.assetId = assetId;
  return cell;
}

function fillCell(cell, asset, index, dataUrl) {
  cell.classList.remove('is-loading');
  cell.replaceChildren();

  const frame = document.createElement('div');
  frame.className = 'page-frame';

  const img = document.createElement('img');
  img.src = dataUrl;
  cell.dataset.shown = dataUrl;
  img.alt = `Page ${index + 1} of ${asset.name}`;
  img.loading = 'lazy';
  frame.append(img);

  const label = document.createElement('span');
  label.className = 'page-number';
  label.textContent = String(index + 1);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'page-check';
  check.setAttribute('aria-label', `Select page ${index + 1} of ${asset.name}`);
  check.addEventListener('click', (event) => {
    // The cell handles selection; let it see the click once, not twice.
    event.stopPropagation();
    setSelected(cell, asset.id, index, check.checked);
    lastClicked = { assetId: asset.id, index };
  });

  // Zooming lives behind its own button rather than on hover: the pointer
  // crosses dozens of pages on the way anywhere, and a preview that opens by
  // itself every time would be noise.
  const zoom = document.createElement('button');
  zoom.className = 'page-zoom';
  zoom.title = `Enlarge page ${index + 1}`;
  zoom.setAttribute('aria-label', `Enlarge page ${index + 1} of ${asset.name}`);
  // An inline SVG rather than a glyph: the arrow characters render thin and
  // inconsistently across platforms, and this one has to read at 24px.
  zoom.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 L21 21"/>' +
    '<path d="M10.5 7.5 v6 M7.5 10.5 h6"/></svg>';
  zoom.addEventListener('click', (event) => {
    event.stopPropagation();
    openViewer(asset.id, index);
  });

  // The whole card is the hit target, which is far easier to hit than a 16px box.
  cell.addEventListener('click', (event) => {
    if (event.shiftKey && lastClicked?.assetId === asset.id) {
      selectRange(cell.parentElement, asset.id, lastClicked.index, index);
      return;
    }
    setSelected(cell, asset.id, index, !selection.has(key(asset.id, index)));
    lastClicked = { assetId: asset.id, index };
  });

  cell.append(check, zoom, frame, label);
  cell.draggable = true;
  attachPageReordering(cell, asset.id, index);
}

/**
 * Drag a page to move it.
 *
 * Reordering is the one PDF edit that cannot be described by a page number
 * alone, so it wants a pointer rather than a form. The drop lands in the gap
 * between two pages, marked by a line, the same way photographs move.
 *
 * The payload carries the document as well as the page, because the gap the
 * page lands in may belong to a different file.
 */
function attachPageReordering(cell, assetId, index) {
  cell.addEventListener('dragstart', (event) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `${assetId}:${index}`);
    cell.classList.add('is-dragging');
    // Every group lights up its drop edge while a page is in the air, so it is
    // obvious that pages can cross from one document into another.
    for (const group of document.querySelectorAll('.page-group')) {
      group.classList.add('is-drop-target');
    }
  });
  cell.addEventListener('dragend', clearPageMarkers);
}

function clearPageMarkers() {
  for (const cell of document.querySelectorAll('.page-cell')) {
    cell.classList.remove('is-dragging', 'drop-before', 'drop-after');
  }
  for (const group of document.querySelectorAll('.page-group')) {
    group.classList.remove('is-drop-target', 'is-drop-over');
  }
}

/** The gap nearest the pointer, as an index into that grid's page order. */
function pageGapUnderPointer(grid, event) {
  const cells = [...grid.querySelectorAll('.page-cell:not(.is-dragging)')];
  if (cells.length === 0) return { distance: 0, cell: null, edge: 'before', index: 0 };

  let best = null;
  for (const [position, cell] of cells.entries()) {
    const box = cell.getBoundingClientRect();
    for (const [edge, x] of [['before', box.left], ['after', box.right]]) {
      const distance = Math.hypot(x - event.clientX, box.top + box.height / 2 - event.clientY);
      if (!best || distance < best.distance) {
        best = { distance, cell, edge, index: edge === 'before' ? position : position + 1 };
      }
    }
  }
  return best;
}

/** One listener per grid: the gaps belong to it, not to any one page. */
function attachGridReordering(grid) {
  if (grid.dataset.reorderReady) return;
  grid.dataset.reorderReady = 'true';

  grid.addEventListener('dragover', (event) => {
    // Only a page being moved, never a file dropped from outside the window.
    if (event.dataTransfer.types.includes('Files')) return;
    if (!event.dataTransfer.types.includes('text/plain')) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';

    const gap = pageGapUnderPointer(grid, event);
    for (const cell of document.querySelectorAll('.page-cell')) {
      cell.classList.remove('drop-before', 'drop-after');
    }
    for (const group of document.querySelectorAll('.page-group')) {
      group.classList.toggle('is-drop-over', group.contains(grid));
    }
    if (gap?.cell) gap.cell.classList.add(gap.edge === 'before' ? 'drop-before' : 'drop-after');
  });

  grid.addEventListener('dragleave', (event) => {
    if (!grid.contains(event.relatedTarget)) {
      grid.closest('.page-group')?.classList.remove('is-drop-over');
    }
  });

  grid.addEventListener('drop', (event) => {
    if (event.dataTransfer.types.includes('Files')) return;
    const raw = event.dataTransfer.getData('text/plain');
    if (raw === '') return;
    event.preventDefault();
    event.stopPropagation();

    const split = raw.lastIndexOf(':');
    const fromAssetId = raw.slice(0, split);
    const sourceIndex = Number(raw.slice(split + 1));
    const gap = pageGapUnderPointer(grid, event);
    const intoAssetId = grid.dataset.assetId;
    clearPageMarkers();
    if (!gap || Number.isNaN(sourceIndex)) return;

    if (fromAssetId === intoAssetId) {
      movePage(fromAssetId, sourceIndex, gap.index);
    } else {
      // A page crossing the boundary is the user saying these are one document
      // after all. Joining them is what makes that true, and the workspace
      // does it: the grid only reports what the pointer did.
      window.dispatchEvent(
        new CustomEvent('keepitoffline:mix-pages', {
          detail: { fromAssetId, sourceIndex, intoAssetId, atIndex: gap.index },
        }),
      );
    }
  });
}

/**
 * Queue a reorder that moves one page into a gap.
 *
 * The order is expressed against the document as it stands after the enabled
 * operations, since that is what the grid is showing and what the user is
 * pointing at.
 */
function movePage(assetId, sourceIndex, gapIndex) {
  const asset = getAsset(assetId);
  if (!asset) return;

  const ops = operationsFor(assetId).map((op) => ({ type: op.type, params: op.params }));
  const pages = previewPages(asset.meta.pageCount, ops);

  const from = pages.findIndex((p) => p.sourceIndex === sourceIndex);
  if (from === -1) return;

  const order = pages.map((_, i) => i);
  const target = Math.max(0, Math.min(gapIndex > from ? gapIndex - 1 : gapIndex, order.length - 1));
  if (target === from) return;

  const [moved] = order.splice(from, 1);
  order.splice(target, 0, moved);

  pushOperation({
    type: 'reorder_pages',
    assetIds: assetId,
    params: { order },
    summary: `Move page ${from + 1} to position ${target + 1}`,
    source: 'user',
  });
}

/** Single source of truth for "this page is selected", used by every path. */
function setSelected(cell, assetId, index, selected) {
  const entry = key(assetId, index);
  selected ? selection.add(entry) : selection.delete(entry);
  cell.classList.toggle('is-selected', selected);
  const check = cell.querySelector('.page-check');
  if (check) check.checked = selected;
  onChange(selection.size);
}

/**
 * Shift-click: select everything between the last click and this one.
 *
 * The range runs over what is on screen rather than over source page numbers,
 * because the cells sit in the order the stack leaves them and "everything
 * between these two" means the pages the user can see between them.
 */
function selectRange(grid, assetId, from, to) {
  const cells = [...grid.children];
  const at = (index) => cells.findIndex((cell) => Number(cell.dataset.index) === index);
  const [start, end] = [at(from), at(to)].sort((a, b) => a - b);
  if (start === -1) return;

  for (let i = start; i <= end; i++) {
    const cell = cells[i];
    if (cell) setSelected(cell, assetId, Number(cell.dataset.index), true);
  }
}

/** Grey out pages the enabled operations would remove, and apply rotations. */
export function refresh(container) {
  for (const grid of container.querySelectorAll('.page-grid')) {
    const assetId = grid.dataset.assetId;
    const asset = getAsset(assetId);
    if (!asset) continue;

    const ops = operationsFor(assetId).map((op) => ({ type: op.type, params: op.params }));
    const surviving = previewPages(asset.meta.pageCount, ops);
    const kept = new Map(surviving.map((p) => [p.sourceIndex, p]));
    const cached = thumbs.get(assetId) ?? [];

    // The cells are put in the order the stack leaves them, so a reorder is
    // something the user watches happen rather than something they have to take
    // on trust until the file downloads. Removed pages keep their place at the
    // end, greyed out, since they are still on screen to be put back.
    const rank = new Map(surviving.map((page, position) => [page.sourceIndex, position]));
    const ordered = [...grid.children].sort(
      (a, b) =>
        (rank.get(Number(a.dataset.index)) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(Number(b.dataset.index)) ?? Number.MAX_SAFE_INTEGER),
    );
    // Only touch the DOM when the order actually changed: reappending every
    // cell on each refresh would restart image decoding and flicker the grid.
    if (ordered.some((cell, i) => cell !== grid.children[i])) grid.append(...ordered);

    for (const cell of grid.children) {
      const index = Number(cell.dataset.index);
      const page = kept.get(index);
      cell.classList.toggle('is-removed', !page);

      const rotation = page?.rotation ?? 0;
      const img = cell.querySelector('img');
      if (!img) continue;

      // A redacted page shows the flattened image with the black already burned
      // in, so what is on screen is what the file will contain. Unticking the
      // operation puts the original thumbnail back.
      const wanted = page?.redacted ?? cached[index];
      if (wanted && cell.dataset.shown !== wanted) {
        img.src = wanted;
        cell.dataset.shown = wanted;
      }
      cell.classList.toggle('is-redacted', Boolean(page?.redacted));

      // The number under a page is where it lands in the finished document, not
      // where it started: after a reorder those differ, and the one that
      // matters is the one the reader will see. Removed pages keep their
      // original number, since that is how the user still thinks of them.
      const label = cell.querySelector('.page-number');
      if (label) {
        const position = rank.get(index);
        label.textContent = String((position ?? index) + 1);
      }

      img.style.rotate = `${rotation}deg`;
      // At a quarter turn the page is wider than it is tall, so the frame has to
      // swap its proportions too. Without this the image keeps its upright
      // footprint and spills over the neighbouring cells.
      const quarterTurned = rotation === 90 || rotation === 270;
      cell.classList.toggle('is-quarter-turned', quarterTurned);
    }
  }
}

/**
 * The ticked pages, grouped by the document they belong to.
 *
 * @returns {Map<string, number[]>} assetId -> source indices, ascending.
 */
export function getSelectionByAsset() {
  const byAsset = new Map();
  for (const entry of selection) {
    const split = entry.lastIndexOf(':');
    const assetId = entry.slice(0, split);
    const index = Number(entry.slice(split + 1));
    if (!byAsset.has(assetId)) byAsset.set(assetId, []);
    byAsset.get(assetId).push(index);
  }
  for (const indices of byAsset.values()) indices.sort((a, b) => a - b);
  return byAsset;
}

export function clearSelection(container) {
  selection.clear();
  for (const check of container.querySelectorAll('.page-check')) check.checked = false;
  for (const cell of container.querySelectorAll('.page-cell')) cell.classList.remove('is-selected');
  onChange(0);
}

/**
 * Queue removal of the selected pages, exactly as the tool would.
 *
 * A selection can span documents, so this is one operation per document rather
 * than one overall: each file's pages are its own, and each removal has to undo
 * against the file it came from.
 */
export function removeSelected(container) {
  const byAsset = getSelectionByAsset();
  if (byAsset.size === 0) return;

  for (const [assetId, pages] of byAsset) {
    const asset = getAsset(assetId);
    if (!asset) continue;

    const ops = operationsFor(assetId).map((op) => ({ type: op.type, params: op.params }));
    const remaining = previewPages(asset.meta.pageCount, [
      ...ops,
      { type: 'remove_pages', params: { pages } },
    ]);
    if (remaining.length === 0) {
      window.alert(`A PDF has to keep at least one page, and that would empty ${asset.name}.`);
      continue;
    }

    pushOperation({
      type: 'remove_pages',
      assetIds: assetId,
      params: { pages },
      summary: `Remove ${pages.length} page${pages.length === 1 ? '' : 's'} of ${asset.name}: ${pages
        .map((i) => i + 1)
        .join(', ')}`,
      source: 'user',
    });
  }
  clearSelection(container);
}

/** Queue a rotation of the selected pages, per document. */
export function rotateSelected(container, deg) {
  const byAsset = getSelectionByAsset();
  if (byAsset.size === 0) return;

  for (const [assetId, pages] of byAsset) {
    const asset = getAsset(assetId);
    if (!asset) continue;
    pushOperation({
      type: 'rotate_pages',
      assetIds: assetId,
      params: { pages, degrees: deg },
      summary: `Rotate ${pages.length} page${pages.length === 1 ? '' : 's'} of ${asset.name} by ${deg}°`,
      source: 'user',
    });
  }
  // The selection survives a rotation on purpose: turning the same pages twice
  // to reach 180°, or rotating and then removing them, are both common.
  // Removal is the exception, since those pages are gone from the document.
}

/**
 * Bulk selection, across every loaded document.
 *
 * 'even' and 'odd' go by page number, not index, because that is what "remove
 * the even pages" means to a person. The numbering restarts with each document,
 * which is also what a person means: the odd pages of two files are the odd
 * pages of each, not of some imagined run through both.
 *
 * @param {'all' | 'even' | 'odd'} mode
 */
export function selectPages(container, mode) {
  selection.clear();
  for (const cell of container.querySelectorAll('.page-cell')) {
    const index = Number(cell.dataset.index);
    const pageNumber = index + 1;
    const wanted =
      mode === 'all' ? true : mode === 'even' ? pageNumber % 2 === 0 : pageNumber % 2 === 1;
    const check = cell.querySelector('.page-check');
    if (check) check.checked = wanted;
    cell.classList.toggle('is-selected', wanted);
    if (wanted) selection.add(key(cell.dataset.assetId, index));
  }
  onChange(selection.size);
}

/**
 * The document a control should act on when it needs exactly one.
 *
 * The document holding the current selection, or the only one loaded. With
 * several on the bench and nothing ticked there is no honest answer, so this
 * says so rather than silently picking the first.
 */
export function getCurrentAsset() {
  const byAsset = getSelectionByAsset();
  if (byAsset.size === 1) return getAsset([...byAsset.keys()][0]) ?? null;
  const pdfs = listAssets('pdf');
  return pdfs.length === 1 ? pdfs[0] : null;
}

/** Every loaded PDF, for controls that can act on all of them. */
export function shownAssets() {
  return listAssets('pdf');
}

/** Forget a document's thumbnails, once it has left the bench. */
export function forget(assetId) {
  thumbs.delete(assetId);
}

// --- Enlarged viewer -------------------------------------------------------

/** Open the shared viewer over one document's pages. */
export function openViewer(assetId, index) {
  const asset = getAsset(assetId);
  if (!asset) return;
  const cached = thumbs.get(assetId) ?? [];

  openSharedViewer({
    index,
    total: asset.meta.pageCount,
    caption: (i) => `${asset.name} · page ${i + 1} of ${asset.meta.pageCount}`,
    rotation: (i) => previewOf(asset, i)?.rotation ?? 0,
    placeholder: (i) => previewOf(asset, i)?.redacted ?? cached[i] ?? '',
    // Enlarging a redacted page has to show the redaction. Rendering the
    // original bytes here would put the blacked-out text back on screen at full
    // size, which is the one thing this feature exists to prevent.
    resolve: (i) => {
      const redacted = previewOf(asset, i)?.redacted;
      if (redacted) return Promise.resolve(redacted);
      return renderFullPage(asset.id, asset.bytes, i);
    },
  });
}

/** How the stack currently leaves a source page, for the viewer. */
function previewOf(asset, sourceIndex) {
  const ops = operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params }));
  return (
    previewPages(asset.meta.pageCount, ops).find((p) => p.sourceIndex === sourceIndex) ?? null
  );
}
