// Works out what a document looks like after the enabled operations, without
// touching the actual bytes. The UI needs this to show a live preview of the
// stack, and it lets a removal be undone by simply unchecking the operation.
//
// Pure and synchronous on purpose: this is the one piece of logic both the grid
// and the export path have to agree on.

/**
 * @typedef {Object} PreviewPage
 * @property {number} sourceIndex  Index in the original document.
 * @property {number} rotation     Total rotation to apply, in degrees.
 */

/**
 * @param {number} pageCount  Pages in the original document.
 * @param {Array<{type: string, params: Object}>} operations  Enabled ops, in order.
 * @returns {PreviewPage[]} The resulting pages, in order.
 */
export function previewPages(pageCount, operations) {
  let pages = Array.from({ length: pageCount }, (_, i) => ({ sourceIndex: i, rotation: 0 }));

  for (const op of operations) {
    switch (op.type) {
      case 'remove_pages': {
        // Operation indices address the document as it stands at this point in
        // the stack, which is the same thing the worker does when applying.
        const drop = new Set(op.params.pages);
        pages = pages.filter((_, i) => !drop.has(i));
        break;
      }
      case 'rotate_pages': {
        const turn = new Set(op.params.pages);
        pages = pages.map((page, i) =>
          turn.has(i)
            ? { ...page, rotation: (page.rotation + op.params.degrees) % 360 }
            : page,
        );
        break;
      }
      case 'reorder_pages': {
        pages = op.params.order.map((i) => pages[i]).filter(Boolean);
        break;
      }
      default:
        break;
    }
  }

  return pages;
}
