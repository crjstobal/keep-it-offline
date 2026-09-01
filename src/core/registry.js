// Dynamic WebMCP tool registration.
//
// Tools are not registered all at once. The set of registered tools tracks what
// is actually on the bench: with no files loaded an agent sees two tools, with
// PDFs loaded it sees the PDF tools, and so on. This keeps the agent's choice
// small and correct, and it means the tool list is a description of the current
// page state rather than a static API surface.

import { subscribe, loadedKinds } from './workspace.js';

// The API moved from navigator.modelContext to document.modelContext. Chrome
// still serves the old one under the origin trial, so accept either.
const modelContext = document.modelContext ?? navigator.modelContext;

export const isSupported = Boolean(modelContext);

/** @type {Map<string, {definition: Object, controller: AbortController}>} */
const active = new Map();

/** Everything that could be registered, keyed by name. */
const catalog = new Map();

const registryListeners = new Set();

export function onRegistryChange(fn) {
  registryListeners.add(fn);
  return () => registryListeners.delete(fn);
}

function notifyRegistry() {
  const names = [...active.keys()];
  for (const fn of registryListeners) fn(names);
}

/**
 * Declare a tool and the condition under which it should be available.
 *
 * @param {Object} entry
 * @param {Object} entry.definition  Passed to registerTool as-is.
 * @param {(kinds: Set<string>) => boolean} [entry.when]  Defaults to always.
 */
export function declareTool({ definition, when }) {
  catalog.set(definition.name, { definition, when: when ?? (() => true) });
}

async function register(name) {
  if (active.has(name)) return;
  const entry = catalog.get(name);
  if (!entry) return;

  const controller = new AbortController();
  const { description, inputSchema, annotations, execute } = entry.definition;

  if (document.modelContext) {
    await document.modelContext.registerTool({
      name,
      description,
      inputSchema,
      annotations,
      execute,
    }, { signal: controller.signal });
  } else {
    // Builds still on the origin trial expose the API on navigator instead.
    // The call above is the current one; this is only a fallback.
    await navigator.modelContext.registerTool({
      name,
      description,
      inputSchema,
      annotations,
      execute,
    }, { signal: controller.signal });
  }

  active.set(name, { definition: entry.definition, controller });
}

function unregister(name) {
  const entry = active.get(name);
  if (!entry) return;
  // Deregistration is by AbortSignal; there is no unregisterTool().
  entry.controller.abort();
  active.delete(name);
}

/** Bring the registered set in line with what is on the bench. */
export async function sync() {
  if (!isSupported) return;

  const kinds = loadedKinds();
  const shouldBeActive = new Set();
  for (const [name, entry] of catalog) {
    if (entry.when(kinds)) shouldBeActive.add(name);
  }

  for (const name of active.keys()) {
    if (!shouldBeActive.has(name)) unregister(name);
  }
  for (const name of shouldBeActive) {
    if (!active.has(name)) await register(name);
  }
  notifyRegistry();
}

export function activeToolNames() {
  return [...active.keys()];
}

export function catalogSize() {
  return catalog.size;
}

/** Start tracking workspace changes. Call once, after all tools are declared. */
export function start() {
  if (!isSupported) return false;
  subscribe(() => {
    // Registration is async; workspace changes are not. Queue and let errors surface.
    sync().catch((err) => console.error('[keepitoffline] tool sync failed', err));
  });
  sync().catch((err) => console.error('[keepitoffline] initial tool sync failed', err));
  return true;
}
