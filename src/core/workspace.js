// The workspace: every file the user has opened, held in memory only.
// Nothing here is ever uploaded. There is no server call in this file, by design.

const listeners = new Set();

/** @typedef {'pdf' | 'image'} AssetKind */

/**
 * @typedef {Object} Asset
 * @property {string} id
 * @property {string} name
 * @property {AssetKind} kind
 * @property {ArrayBuffer} bytes  Original bytes, never mutated.
 * @property {Object} meta        Kind-specific facts (page count, dimensions...).
 */

const state = {
  /** @type {Asset[]} */
  assets: [],
  /** Operations are queued, not applied. The user can reorder or disable them. */
  operations: [],
  /**
   * Files the next control will act on, by id.
   *
   * Empty means every file of the kind, which is the common case: grading a
   * whole shoot should not start with selecting all of it. Selecting is how you
   * narrow, not how you begin.
   */
  /** @type {Set<string>} */
  selection: new Set(),
  /** Bytes sent over the network by this app. Displayed in the UI as a promise we keep. */
  bytesUploaded: 0,
};

let nextId = 1;
const makeId = (prefix) => `${prefix}_${nextId++}`;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn(state);
}

export function getState() {
  return state;
}

export function addAsset({ name, kind, bytes, meta = {} }) {
  const asset = { id: makeId(kind), name, kind, bytes, meta };
  state.assets.push(asset);
  notify();
  return asset;
}

export function removeAsset(id) {
  const before = state.assets.length;
  state.assets = state.assets.filter((a) => a.id !== id);
  // A file that has left the bench cannot stay selected, or the next control
  // would act on something that is no longer there.
  state.selection.delete(id);
  // Drop the file from any operation that covered it, and drop operations that
  // are left covering nothing. A batch over forty images survives one of them
  // being removed.
  // A kind-scoped operation carries no ids and outlives any single file: it is
  // dropped only when the last file of its kind goes.
  // A join names its files in params rather than assetIds, so it is pruned by
  // its own rule: it dies with either half, since half a join is not a join.
  for (const op of state.operations) {
    if (op.scope || op.type === 'join') continue;
    op.assetIds = op.assetIds.filter((assetId) => assetId !== id);
  }
  const liveKinds = new Set(state.assets.map((a) => a.kind));
  const gone = (assetId) => !state.assets.some((a) => a.id === assetId);
  state.operations = state.operations.filter((op) => {
    if (op.type === 'join') return !op.params.sources.some(gone) && !gone(op.params.merged);
    return op.scope ? liveKinds.has(op.scope) : op.assetIds.length > 0;
  });

  // A combined document is an artefact of its join and has no life without it.
  const orphans = state.assets.filter(
    (a) => a.meta?.joined && !state.operations.some((op) => op.params?.merged === a.id),
  );
  if (orphans.length > 0) {
    const drop = new Set(orphans.map((a) => a.id));
    state.assets = state.assets.filter((a) => !drop.has(a.id));
    for (const orphan of drop) state.selection.delete(orphan);
  }

  if (state.assets.length !== before) notify();
}

/** Re-render after mutating an asset's metadata in place (a poster frame, say). */
export function touch() {
  notify();
}

/**
 * Move a file to a position in the list.
 *
 * The index is a gap between files rather than a file to land on, which is what
 * a drop marker draws and what a person means by "put it here".
 *
 * Order decides what a contact sheet or a combined document looks like, so it
 * is part of the workspace rather than a detail of how a grid is drawn.
 */
export function moveAssetToIndex(assetId, index) {
  const from = state.assets.findIndex((a) => a.id === assetId);
  if (from === -1) return false;

  // Removing the file first shifts every later gap down by one.
  const target = Math.max(0, Math.min(index > from ? index - 1 : index, state.assets.length - 1));
  if (target === from) return false;

  const [moved] = state.assets.splice(from, 1);
  state.assets.splice(target, 0, moved);
  notify();
  return true;
}

export function getAsset(id) {
  return state.assets.find((a) => a.id === id);
}

// --- Joining ---------------------------------------------------------------
// Joining two documents is an edit like any other, so it lives on the stack and
// undoes by unticking. That means it cannot destroy the files it joins: the
// sources stay on the bench and are merely hidden while the join holds, and the
// combined document is hidden while it does not. Untick the row and the two
// documents are back, with their own edits intact.

/**
 * Which files the bench is showing, and which joins are in force.
 *
 * Joins are resolved in stack order because they stack: join two documents,
 * then join the result to a third. A join only holds if the documents it names
 * are actually on the bench, so unticking an early one quietly stands down the
 * later ones built on top of it. Without that, undoing the inner join of a pair
 * would put its two documents back while the outer combined document, which
 * already contains their pages, was still sitting there: the same pages twice.
 */
function resolveJoins() {
  const hidden = new Set();
  const inForce = new Set();

  for (const op of state.operations) {
    if (op.type !== 'join') continue;
    const holds = op.enabled && op.params.sources.every((id) => !hidden.has(id));
    if (holds) {
      // The sources are inside the combined document now.
      for (const id of op.params.sources) hidden.add(id);
      inForce.add(op.params.merged);
    } else {
      // Nothing joined, so the combined document is the thing that is not real.
      hidden.add(op.params.merged);
    }
  }
  return { hidden, inForce };
}

/** Is this asset the product of a join that is currently in force? */
export function isJoinProduct(assetId) {
  return resolveJoins().inForce.has(assetId);
}

/** The join operation that produced this asset, if any. */
export function joinFor(assetId) {
  return state.operations.find((op) => op.type === 'join' && op.params.merged === assetId) ?? null;
}

/**
 * Files on the bench.
 *
 * Sources swallowed by a join, and combined documents whose join is unticked,
 * are held in state but are not on the bench: every control, every tool and
 * every export reads the bench rather than the raw list, so a join looks the
 * same from all of them.
 */
export function listAssets(kind) {
  const { hidden } = resolveJoins();
  return state.assets.filter((a) => !hidden.has(a.id) && (!kind || a.kind === kind));
}

/** What kinds are currently loaded. Drives which tools stay registered. */
export function loadedKinds() {
  return new Set(listAssets().map((a) => a.kind));
}

// --- Selection -------------------------------------------------------------
// Which files a control acts on. Selecting nothing means the whole kind, so the
// ordinary case ("warm up the photographs") costs no clicks and narrowing is
// something you opt into.
//
// The selection can hold files of several kinds at once: with photographs and
// clips both on the bench, the photo controls read the photographs in it and the
// video controls read the clips, and neither disturbs the other.

/** Selected files of one kind, in bench order. Empty means no narrowing. */
export function selectedAssets(kind) {
  return listAssets(kind).filter((a) => state.selection.has(a.id));
}

/**
 * What a control of this kind should act on, and how to record it.
 *
 * This is the one place that turns "what is selected" into the shape
 * pushOperation wants, so every control and every agent tool answers the
 * question the same way.
 *
 * With nothing selected the operation is scoped to the kind, which is what makes
 * it a standing rule that later files inherit. With a selection it names ids,
 * and stays pinned to those files however many arrive afterwards.
 *
 * @param {AssetKind} kind
 * @returns {{assets: Asset[], scope?: AssetKind, assetIds?: string[], narrowed: boolean}}
 */
export function targetFor(kind) {
  const chosen = selectedAssets(kind);
  if (chosen.length === 0) {
    return { assets: listAssets(kind), scope: kind, narrowed: false };
  }
  return { assets: chosen, assetIds: chosen.map((a) => a.id), narrowed: true };
}

/**
 * Name what an operation covers, for the summary line on the stack.
 *
 * A row on the stack has to keep saying what it did, so this reads the row's own
 * targets rather than today's selection: a live control that keeps rewriting its
 * summary must not start claiming the photographs someone picked afterwards.
 *
 * @param {{scope?: AssetKind, assetIds?: string[]}} target An operation, or a targetFor() result.
 * @param {{one: string, many: string, all: string}} words e.g. photo / photos / every photo
 */
export function describeTarget(target, words) {
  if (target.scope) {
    const loaded = listAssets(target.scope);
    return loaded.length === 1 ? loaded[0].name : words.all;
  }
  const ids = target.assetIds ?? [];
  if (ids.length === 1) return getAsset(ids[0])?.name ?? `1 selected ${words.one}`;
  return `${ids.length} selected ${words.many}`;
}

export function isSelected(id) {
  return state.selection.has(id);
}

export function setSelected(id, selected) {
  if (!getAsset(id)) return false;
  if (selected === state.selection.has(id)) return false;
  if (selected) state.selection.add(id);
  else state.selection.delete(id);
  notify();
  return true;
}

export function toggleSelected(id) {
  return setSelected(id, !state.selection.has(id));
}

/** Replace the selection for one kind, leaving other kinds alone. */
export function setSelection(ids, kind) {
  const keep = kind ? [...state.selection].filter((id) => getAsset(id)?.kind !== kind) : [];
  state.selection = new Set([...keep, ...ids.filter((id) => getAsset(id))]);
  notify();
}

/** Clear the selection, for one kind or entirely. */
export function clearSelection(kind) {
  if (!kind) {
    if (state.selection.size === 0) return;
    state.selection.clear();
    notify();
    return;
  }
  const chosen = selectedAssets(kind);
  if (chosen.length === 0) return;
  for (const asset of chosen) state.selection.delete(asset.id);
  notify();
}

// --- Operation stack -------------------------------------------------------
// Agents and humans both push here. Nothing is destructive until export, so a
// wrong call from either side costs one click to undo.

/**
 * Queue an operation over one or more files.
 *
 * One operation can cover many files on purpose: grading forty photographs is a
 * single thing the user did, and it should be one line in the stack that undoes
 * in one click, not forty identical entries.
 *
 * An operation can instead cover a whole kind. "Warm up the photographs" is a
 * decision about the photographs on the bench, not about the six that happened
 * to be loaded when the slider moved: drop four more in and they arrive graded
 * like the rest. Pass `scope: 'image'` for that; pass explicit ids when the user
 * or the agent really did single files out.
 *
 * @param {Object} op
 * @param {string} op.type                 e.g. 'remove_pages'
 * @param {string|string[]} [op.assetIds]  One id or several.
 * @param {AssetKind} [op.scope]           Cover every file of this kind, including later ones.
 * @param {Object} op.params
 * @param {string} op.summary              Human-readable, shown in the stack UI.
 * @param {'agent'|'user'} op.source
 */
export function pushOperation({ type, assetIds, scope, params, summary, source = 'user' }) {
  const ids = assetIds === undefined ? [] : Array.isArray(assetIds) ? [...assetIds] : [assetIds];
  const op = {
    id: makeId('op'),
    type,
    assetIds: ids,
    scope,
    params,
    summary,
    source,
    enabled: true,
    at: Date.now(),
  };
  state.operations.push(op);
  notify();
  return op;
}

/**
 * Change an operation that is already on the stack.
 *
 * Dragging a slider produces a value every few milliseconds. Pushing each one
 * would bury the stack in near-identical rows, so a live control pushes once and
 * then edits that row as it moves: one entry, one undo, whatever the pointer did
 * on the way there.
 */
export function updateOperation(id, { params, summary }) {
  const op = state.operations.find((o) => o.id === id);
  if (!op) return false;
  if (params) op.params = { ...op.params, ...params };
  if (summary) op.summary = summary;
  notify();
  return true;
}

export function setOperationEnabled(id, enabled) {
  const op = state.operations.find((o) => o.id === id);
  if (!op) return false;
  op.enabled = enabled;
  notify();
  return true;
}

export function removeOperation(id) {
  const op = state.operations.find((o) => o.id === id);
  state.operations = state.operations.filter((o) => o.id !== id);
  // Throwing away a join throws away the document it made, along with anything
  // queued against that document: those edits were to pages that, once the two
  // files are separate again, belong to neither.
  if (op?.type === 'join') dropMerged(op.params.merged);
  notify();
}

/** Forget a combined document and every edit that named it. */
function dropMerged(mergedId) {
  state.assets = state.assets.filter((a) => a.id !== mergedId);
  state.selection.delete(mergedId);
  state.operations = state.operations.filter(
    (o) => o.scope || o.type === 'join' || !o.assetIds.includes(mergedId),
  );
}

export function moveOperation(id, toIndex) {
  const from = state.operations.findIndex((o) => o.id === id);
  if (from === -1) return false;
  const [op] = state.operations.splice(from, 1);
  state.operations.splice(Math.max(0, Math.min(toIndex, state.operations.length)), 0, op);
  notify();
  return true;
}

export function clearOperations() {
  // Undoing everything includes undoing the joins, which puts the documents
  // that were joined back on the bench.
  for (const op of state.operations) {
    if (op.type === 'join') dropMerged(op.params.merged);
  }
  state.operations = [];
  notify();
}

/** Does this operation cover this asset: named explicitly, or by its kind. */
function covers(op, asset) {
  // A join is not an edit to any one document: it is the reason a document
  // exists. It must never reach the worker as a step to apply.
  if (op.type === 'join') return false;
  if (op.scope) return asset.kind === op.scope;
  return op.assetIds.includes(asset.id);
}

/** Enabled operations covering one asset, in stack order. */
export function operationsFor(assetId) {
  const asset = getAsset(assetId);
  if (!asset) return [];
  return state.operations.filter((op) => op.enabled && covers(op, asset));
}
