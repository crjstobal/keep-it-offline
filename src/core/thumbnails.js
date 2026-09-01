// Page thumbnails, rendered with pdf.js.
//
// Rendering is queued one page at a time and yields between pages, so dropping
// a large document does not lock up the interface. Thumbnails are cached per
// asset because re-rendering on every state change would be wasteful.

import * as pdfjs from '../../assets/vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc =
  new URL('../../assets/vendor/pdf.worker.min.mjs', import.meta.url).href;

const THUMB_WIDTH = 150;

/** @type {Map<string, string[]>} assetId -> data URLs, indexed by page */
const cache = new Map();

/**
 * Render every page of a PDF to a small canvas.
 *
 * @param {string} assetId
 * @param {ArrayBuffer} bytes
 * @param {(page: number, total: number, dataUrl: string) => void} onPage
 *        Called as each page finishes, so the grid can fill in progressively.
 */
export async function renderThumbnails(assetId, bytes, onPage) {
  if (cache.has(assetId)) {
    const cached = cache.get(assetId);
    cached.forEach((url, i) => onPage(i, cached.length, url));
    return cached;
  }

  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const urls = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const url = canvas.toDataURL('image/jpeg', 0.7);
    urls.push(url);
    onPage(pageNumber - 1, doc.numPages, url);

    // Let the browser paint and stay responsive between pages.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  cache.set(assetId, urls);
  return urls;
}

export function forgetThumbnails(assetId) {
  cache.delete(assetId);
  fullCache.delete(assetId);
}

/** @type {Map<string, Map<number, string>>} assetId -> page -> data URL */
const fullCache = new Map();

const FULL_WIDTH = 1000;

/**
 * Render one page at a size worth looking at. The grid's thumbnails are 150px
 * wide, which is fine at a glance but blurry when enlarged, so the viewer asks
 * for a proper render of just the page it is showing.
 */
export async function renderFullPage(assetId, bytes, pageIndex) {
  const forAsset = fullCache.get(assetId) ?? new Map();
  if (forAsset.has(pageIndex)) return forAsset.get(pageIndex);

  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: FULL_WIDTH / base.width });

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

  const url = canvas.toDataURL('image/jpeg', 0.85);
  forAsset.set(pageIndex, url);
  fullCache.set(assetId, forAsset);
  return url;
}
