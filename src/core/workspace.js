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
  // Operations that targeted a removed asset are meaningless now.
  state.operations = state.operations.filter((op) => op.assetId !== id);
  if (state.assets.length !== before) notify();
}

export function getAsset(id) {
  return state.assets.find((a) => a.id === id);
}

export function listAssets(kind) {
  return kind ? state.assets.filter((a) => a.kind === kind) : state.assets;
}

/** What kinds are currently loaded. Drives which tools stay registered. */
export function loadedKinds() {
  return new Set(state.assets.map((a) => a.kind));
}

// --- Operation stack -------------------------------------------------------
// Agents and humans both push here. Nothing is destructive until export, so a
// wrong call from either side costs one click to undo.

/**
 * @param {Object} op
 * @param {string} op.type      e.g. 'remove_pages'
 * @param {string} op.assetId
 * @param {Object} op.params
 * @param {string} op.summary   Human-readable, shown in the stack UI.
 * @param {'agent'|'user'} op.source
 */
export function pushOperation({ type, assetId, params, summary, source = 'user' }) {
  const op = {
    id: makeId('op'),
    type,
    assetId,
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

export function setOperationEnabled(id, enabled) {
  const op = state.operations.find((o) => o.id === id);
  if (!op) return false;
  op.enabled = enabled;
  notify();
  return true;
}

export function removeOperation(id) {
  state.operations = state.operations.filter((o) => o.id !== id);
  notify();
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
  state.operations = [];
  notify();
}

/** Enabled operations for one asset, in stack order. */
export function operationsFor(assetId) {
  return state.operations.filter((op) => op.assetId === assetId && op.enabled);
}
