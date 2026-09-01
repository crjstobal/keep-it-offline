// PDF work happens here so the main thread stays responsive while an agent
// runs a batch. Tools return immediately with an acknowledgement; this worker
// posts progress back and the UI updates as results arrive.

import { PDFDocument, degrees } from '../../assets/vendor/pdf-lib.mjs';

/**
 * Apply the enabled operation stack to one document, in order.
 *
 * Every step rebuilds the document by copying the pages it wants into a fresh
 * one. That is deliberate: pdf-lib's removePage leaves getPages() returning the
 * original list, so mutating in place means later operations address pages that
 * are no longer in the document and their changes are silently dropped on save.
 * Rebuilding keeps indices honest, and matches previewPages() exactly.
 */
async function applyOperations(bytes, operations) {
  let doc = await PDFDocument.load(bytes);

  for (const op of operations) {
    switch (op.type) {
      case 'remove_pages': {
        const drop = new Set(op.params.pages);
        const keep = [];
        for (let i = 0; i < doc.getPageCount(); i++) {
          if (!drop.has(i)) keep.push(i);
        }
        doc = await rebuild(doc, keep);
        break;
      }
      case 'rotate_pages': {
        const turn = new Set(op.params.pages);
        const pages = doc.getPages();
        for (const i of turn) {
          const page = pages[i];
          if (!page) continue;
          const current = page.getRotation().angle;
          page.setRotation(degrees((current + op.params.degrees) % 360));
        }
        break;
      }
      case 'reorder_pages': {
        doc = await rebuild(doc, op.params.order);
        break;
      }
      case 'redact': {
        doc = await replaceWithImages(doc, op.params.rendered ?? []);
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

/**
 * Swap redacted pages for flattened images of themselves.
 *
 * A black rectangle drawn over text hides nothing: the glyphs stay in the file
 * and any reader copies them straight back out. The page is therefore rendered
 * to an image with the black already burned in, and that image replaces the
 * page, so the covered text is gone rather than merely hidden.
 *
 * Only pages that actually had matches are replaced; the rest keep their text.
 */
async function replaceWithImages(doc, rendered) {
  for (const entry of rendered) {
    const index = entry.page - 1;
    const target = doc.getPages()[index];
    if (!target) continue;

    const { width, height } = target.getSize();
    const image = await doc.embedJpg(entry.bytes);

    // A fresh page, so nothing of the original content stream survives.
    const replacement = doc.insertPage(index, [width, height]);
    replacement.drawImage(image, { x: 0, y: 0, width, height });
    doc.removePage(index + 1);
  }

  // removePage leaves getPages() stale, so rebuild to make the result honest.
  return rebuild(doc, [...Array(doc.getPageCount()).keys()]);
}

/** A new document holding the given source pages, in the given order. */
async function rebuild(doc, indices) {
  const valid = indices.filter((i) => i >= 0 && i < doc.getPageCount());
  const target = await PDFDocument.create();
  const copied = await target.copyPages(doc, valid);
  for (const page of copied) target.addPage(page);
  return target;
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

/**
 * Join several documents into one, each with its own edits already applied.
 *
 * Merging after editing rather than before is what makes the result
 * predictable: pages removed from the second document are gone before it is
 * appended, so the page numbers a person saw are the ones they get.
 */
async function mergeDocuments(sources) {
  const merged = await PDFDocument.create();

  for (const source of sources) {
    const edited = await applyOperations(source.bytes, source.operations ?? []);
    const copied = await merged.copyPages(edited, edited.getPageIndices());
    for (const page of copied) merged.addPage(page);
  }
  return merged;
}

self.onmessage = async (event) => {
  const { id, action, payload } = event.data;
  try {
    let result;
    switch (action) {
      case 'describe':
        result = await describe(payload.bytes);
        break;
      case 'merge': {
        const merged = await mergeDocuments(payload.sources);
        const out = await merged.save();
        self.postMessage(
          { id, ok: true, result: { bytes: out.buffer, pageCount: merged.getPageCount() } },
          [out.buffer],
        );
        return;
      }
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
