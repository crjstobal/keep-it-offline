import { PDFDocument, degrees } from 'pdf-lib';

export async function applyOperations(bytes, operations) {
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
      default:
        // Unknown operations are skipped rather than throwing: a stale op in
        // the stack should not take down an otherwise valid export.
        console.warn('[pdf.worker] unknown operation', op.type);
    }
  }

  return doc;
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

