// PDF work happens here so the main thread stays responsive while an agent
// runs a batch. Tools return immediately with an acknowledgement; this worker
// posts progress back and the UI updates as results arrive.

import { PDFDocument, degrees } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

/** Apply the enabled operation stack to one document, in order. */
async function applyOperations(bytes, operations) {
  let doc = await PDFDocument.load(bytes);

  for (const op of operations) {
    switch (op.type) {
      case 'remove_pages': {
        // Remove from the end so earlier indices stay valid.
        const indices = [...new Set(op.params.pages)].sort((a, b) => b - a);
        for (const i of indices) {
          if (i >= 0 && i < doc.getPageCount()) doc.removePage(i);
        }
        break;
      }
      case 'rotate_pages': {
        const pages = doc.getPages();
        for (const i of op.params.pages) {
          const page = pages[i];
          if (!page) continue;
          const current = page.getRotation().angle;
          page.setRotation(degrees((current + op.params.degrees) % 360));
        }
        break;
      }
      case 'reorder_pages': {
        const source = doc;
        const target = await PDFDocument.create();
        const copied = await target.copyPages(source, op.params.order);
        for (const page of copied) target.addPage(page);
        doc = target;
        break;
      }
      default:
        // Unknown operations are skipped rather than throwing: a stale op in
        // the stack should not take down an otherwise valid export.
        console.warn('[pdf.worker] unknown operation', op.type);
    }
  }

  return doc;
}

async function describe(bytes) {
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map((page, i) => {
    const { width, height } = page.getSize();
    return {
      index: i,
      width: Math.round(width),
      height: Math.round(height),
      orientation: width > height ? 'landscape' : 'portrait',
      rotation: page.getRotation().angle,
    };
  });
  return { pageCount: pages.length, pages };
}

self.onmessage = async (event) => {
  const { id, action, payload } = event.data;
  try {
    let result;
    switch (action) {
      case 'describe':
        result = await describe(payload.bytes);
        break;
      case 'apply': {
        const doc = await applyOperations(payload.bytes, payload.operations);
        const out = await doc.save();
        result = { bytes: out.buffer, pageCount: doc.getPageCount() };
        self.postMessage({ id, ok: true, result }, [out.buffer]);
        return;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
