// The colour looks on offer.
//
// Each entry points at a standard .cube file in assets/luts, so replacing a look
// is a matter of dropping in a different file: no code changes, and any LUT
// exported from Lightroom, Resolve or Photoshop will work.

import { imageCall } from './worker-bridge.js';
import { parseCube } from './lut-math.js';

const LUTS = [
  {
    name: 'black-and-white',
    file: 'black-and-white.cube',
    description: 'Luma-weighted monochrome with a gentle contrast curve.',
  },
  {
    name: 'teal-and-orange',
    file: 'teal-and-orange.cube',
    description: 'Cinema grade: cyan shadows, warm highlights. Reads as filmic on most photos.',
  },
  {
    name: 'warm',
    file: 'warm.cube',
    description: 'A golden cast, like late afternoon light.',
  },
  {
    name: 'cool',
    file: 'cool.cube',
    description: 'A blue cast, for overcast or yellow-tinted interior shots.',
  },
  {
    name: 'faded',
    file: 'faded.cube',
    description: 'Lifted blacks and pulled highlights: the washed-out film look.',
  },
];

const loaded = new Set();

export function availableLuts() {
  return LUTS.map(({ name, description }) => ({ name, description }));
}

/**
 * Fetch a .cube file and hand it to the image worker, once per session.
 * The file ships with the app, so this is a same-origin request for an asset,
 * not an upload: no user data is involved.
 */
export async function ensureLutLoaded(name) {
  if (loaded.has(name)) return;

  const entry = LUTS.find((lut) => lut.name === name);
  if (!entry) throw new Error(`Unknown look "${name}".`);

  const response = await fetch(new URL(`../../assets/luts/${entry.file}`, import.meta.url));
  if (!response.ok) throw new Error(`Could not load the ${name} look.`);

  await imageCall('load_lut', { name, text: await response.text() });
  loaded.add(name);
}

/** @type {Map<string, object>} Parsed tables for the main-thread video path. */
const parsed = new Map();

/**
 * The parsed LUT itself, for code that grades on the main thread.
 *
 * Images go through the worker, which keeps its own copy; video cannot, because
 * a <video> element only decodes on the document. Both read the same .cube file
 * through the same parser, so the look is identical either way.
 */
export async function lutFor(name) {
  if (parsed.has(name)) return parsed.get(name);

  const entry = LUTS.find((lut) => lut.name === name);
  if (!entry) throw new Error(`Unknown look "${name}".`);

  const response = await fetch(new URL(`../../assets/luts/${entry.file}`, import.meta.url));
  if (!response.ok) throw new Error(`Could not load the ${name} look.`);

  const table = parseCube(await response.text());
  parsed.set(name, table);
  return table;
}
