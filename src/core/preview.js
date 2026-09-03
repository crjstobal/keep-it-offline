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
 * @property {string} [redacted]   Data URL of the flattened page, when blacked out.
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
      case 'redact': {
        // Redaction replaces a page with a flattened image of itself. The grid
        // has to show that image, or the black boxes exist only in the exported
        // file and the user is asked to trust a change they cannot see.
        //
        // The operation names pages of the original document, which is what
        // findMatches reported, so the match is on sourceIndex rather than on
        // the page's current position.
        const byPage = new Map(
          (op.params.rendered ?? []).map((entry) => [entry.page - 1, entry.preview]),
        );
        pages = pages.map((page) =>
          byPage.has(page.sourceIndex)
            ? { ...page, redacted: byPage.get(page.sourceIndex) }
            : page,
        );
        break;
      }
      default:
        break;
    }
  }

  return pages;
}
