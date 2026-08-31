// PDF tools. These are declared, not registered: registry.js registers them
// only while a PDF is actually on the bench.
//
// Every tool that changes something pushes onto the operation stack instead of
// mutating bytes. The user sees the operation appear and can disable it. That
// is what makes it safe to let an agent drive.

import { declareTool } from '../core/registry.js';
import { getAsset, listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { previewPages } from '../core/preview.js';

const hasPdf = (kinds) => kinds.has('pdf');

/** Resolve the target document: an explicit id, or the only PDF loaded. */
function resolvePdf(fileId) {
  const pdfs = listAssets('pdf');
  if (fileId) {
    const asset = getAsset(fileId);
    if (!asset || asset.kind !== 'pdf') throw new Error(`No PDF with id "${fileId}"`);
    return asset;
  }
  if (pdfs.length === 0) throw new Error('No PDF is loaded.');
  if (pdfs.length > 1) {
    const names = pdfs.map((p) => `${p.id} (${p.name})`).join(', ');
    throw new Error(`Several PDFs are loaded, pass file_id. Available: ${names}`);
  }
  return pdfs[0];
}

/**
 * Page numbers are 1-based for the agent (that is how humans and the UI talk
 * about pages) and 0-based internally.
 */
function toIndices(pages, pageCount) {
  const indices = [];
  for (const n of pages) {
    const i = n - 1;
    if (i < 0 || i >= pageCount) {
      throw new Error(`Page ${n} is out of range: the document has ${pageCount} pages.`);
    }
    indices.push(i);
  }
  return indices;
}

declareTool({
  when: hasPdf,
  definition: {
    name: 'describe_pdf',
    description:
      'Describe a loaded PDF: page count, and per page the size, orientation and rotation. ' +
      'Use this before removing or rotating pages so you know what you are working with. ' +
      'Returns JSON. Page numbers are 1-based.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'Which PDF to describe. Optional when only one PDF is loaded.',
        },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async ({ file_id }) => {
      const asset = resolvePdf(file_id);
      const { pageCount, pages } = asset.meta;
      return JSON.stringify({
        file_id: asset.id,
        name: asset.name,
        page_count: pageCount,
        pages: pages.map((p) => ({
          page: p.index + 1,
          width: p.width,
          height: p.height,
          orientation: p.orientation,
          rotation: p.rotation,
        })),
      });
    },
  },
});

declareTool({
  when: hasPdf,
  definition: {
    name: 'remove_pages',
    description:
      'Queue removal of the given pages from a PDF. Page numbers are 1-based. ' +
      'This does not modify the file: it adds a reversible operation to the stack, ' +
      'which the user can see and disable. Call apply_and_export to produce the file.',
    inputSchema: {
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Pages to remove, 1-based. Example: [2, 4, 6].',
        },
        file_id: {
          type: 'string',
          description: 'Which PDF to act on. Optional when only one PDF is loaded.',
        },
      },
      required: ['pages'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ pages, file_id }) => {
      const asset = resolvePdf(file_id);
      const indices = toIndices(pages, asset.meta.pageCount);
      const sorted = [...pages].sort((a, b) => a - b);

      // A PDF with no pages is not a valid file, so refuse rather than
      // producing something the user cannot open.
      const remaining = previewPages(asset.meta.pageCount, [
        ...operationsFor(asset.id).map((op) => ({ type: op.type, params: op.params })),
        { type: 'remove_pages', params: { pages: indices } },
      ]);
      if (remaining.length === 0) {
        throw new Error(
          'That would remove every page, and a PDF must keep at least one. ' +
            'Leave at least one page, or remove the file from the bench instead.',
        );
      }
      pushOperation({
        type: 'remove_pages',
        assetIds: asset.id,
        params: { pages: indices },
        summary: `Remove ${indices.length} page${indices.length === 1 ? '' : 's'}: ${sorted.join(', ')}`,
        source: 'agent',
      });
      return `Queued removal of ${indices.length} page(s) from ${asset.name}. ${
        asset.meta.pageCount - indices.length
      } pages will remain. The operation is on the stack and can be undone by the user.`;
    },
  },
});

declareTool({
  when: hasPdf,
  definition: {
    name: 'rotate_pages',
    description:
      'Queue a rotation of the given pages of a PDF. Page numbers are 1-based. ' +
      'Rotation is relative to the current orientation of each page. ' +
      'Adds a reversible operation to the stack rather than modifying the file.',
    inputSchema: {
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Pages to rotate, 1-based.',
        },
        degrees: {
          type: 'integer',
          enum: [90, 180, 270],
          description: 'Clockwise rotation to add to each page.',
        },
        file_id: {
          type: 'string',
          description: 'Which PDF to act on. Optional when only one PDF is loaded.',
        },
      },
      required: ['pages', 'degrees'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ pages, degrees: deg, file_id }) => {
      const asset = resolvePdf(file_id);
      const indices = toIndices(pages, asset.meta.pageCount);
      pushOperation({
        type: 'rotate_pages',
        assetIds: asset.id,
        params: { pages: indices, degrees: deg },
        summary: `Rotate ${indices.length} page(s) by ${deg}°`,
        source: 'agent',
      });
      return `Queued a ${deg}° rotation of ${indices.length} page(s) in ${asset.name}.`;
    },
  },
});
