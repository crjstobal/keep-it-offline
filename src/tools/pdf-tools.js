// PDF tools. These are declared, not registered: registry.js registers them
// only while a PDF is actually on the bench.
//
// Every tool that changes something pushes onto the operation stack instead of
// mutating bytes. The user sees the operation appear and can disable it. That
// is what makes it safe to let an agent drive.

import { declareTool } from '../core/registry.js';
import { getAsset, listAssets, operationsFor, pushOperation } from '../core/workspace.js';
import { previewPages } from '../core/preview.js';
import { findBlankPages, findMatches, rasterisePages } from '../core/redact.js';

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

declareTool({
  when: hasPdf,
  definition: {
    name: 'find_in_pdf',
    description:
      'Count occurrences of some text or a pattern in a PDF and report which pages they ' +
      'are on. This deliberately returns counts and page numbers only, never the matched ' +
      'text or its surroundings: use it to locate things without the document contents ' +
      'passing through you. Returns JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Literal text to look for.' },
        pattern: {
          type: 'string',
          description: 'A regular expression, as an alternative to text.',
        },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['email', 'phone', 'iban', 'card', 'id_number', 'date'],
          },
          description: 'Kinds of personal data to look for.',
        },
        file_id: { type: 'string', description: 'Optional when only one PDF is loaded.' },
      },
    },
    annotations: { readOnlyHint: true },
    execute: async ({ text, pattern, categories, file_id }) => {
      const asset = resolvePdf(file_id);
      if (!text && !pattern && !categories?.length) {
        throw new Error('Give text, a pattern, or at least one category to look for.');
      }

      const { total, pages, pageCount } = await findMatches(asset.bytes, {
        text,
        pattern,
        categories,
      });
      return JSON.stringify({
        file_id: asset.id,
        matches: total,
        pages_with_matches: pages.map((p) => p.page),
        page_count: pageCount,
        note: 'Counts and page numbers only. The matched text is not returned.',
      });
    },
  },
});

declareTool({
  when: hasPdf,
  definition: {
    name: 'redact_pdf',
    description:
      'Permanently black out text in a PDF. Give literal text, a pattern, or categories of ' +
      'personal data such as email addresses or card numbers. Redacted pages are flattened ' +
      'to images, so the covered text is removed from the file rather than merely hidden ' +
      'behind a rectangle, which is what most tools do and why their output can be copied ' +
      'straight back out. This runs entirely in the browser: the document is never uploaded, ' +
      'and the matched text is not returned to you.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Literal text to black out.' },
        pattern: { type: 'string', description: 'A regular expression, as an alternative.' },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['email', 'phone', 'iban', 'card', 'id_number', 'date'],
          },
          description: 'Kinds of personal data to black out.',
        },
        file_id: { type: 'string', description: 'Optional when only one PDF is loaded.' },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ text, pattern, categories, file_id }) => {
      const asset = resolvePdf(file_id);
      if (!text && !pattern && !categories?.length) {
        throw new Error('Give text, a pattern, or at least one category to redact.');
      }

      const { total, pages } = await findMatches(asset.bytes, { text, pattern, categories });
      if (total === 0) {
        return 'Nothing matched, so there is nothing to redact. Try find_in_pdf with a broader pattern.';
      }

      // The flattened pages are produced here, on the main thread, because
      // rendering needs a canvas; the worker only assembles the final file.
      const rendered = await rasterisePages(asset.bytes, pages);
      const what = [
        text && `"${text}"`,
        pattern && `pattern /${pattern}/`,
        categories?.length && categories.join(', '),
      ]
        .filter(Boolean)
        .join(', ');

      pushOperation({
        type: 'redact',
        assetIds: asset.id,
        params: { rendered, pages: pages.map((p) => p.page) },
        summary: `Redact ${total} match${total === 1 ? '' : 'es'} of ${what}`,
        source: 'agent',
      });

      return `Queued redaction of ${total} match(es) across ${pages.length} page(s) of ${asset.name}. Those pages are flattened to images on export, so the text is removed rather than covered. The user can see the operation and undo it before exporting.`;
    },
  },
});

declareTool({
  when: hasPdf,
  definition: {
    name: 'remove_blank_pages',
    description:
      'Find the pages with nothing on them and queue their removal. A page counts as blank ' +
      'when it has no text and virtually no ink, so a page holding only a faint header is ' +
      'caught but a chart or a photograph is not. Call with dry_run to see which pages ' +
      'would go without queueing anything.',
    inputSchema: {
      type: 'object',
      properties: {
        dry_run: {
          type: 'boolean',
          description: 'Report the blank pages without queueing a removal. Defaults to false.',
        },
        file_id: { type: 'string', description: 'Optional when only one PDF is loaded.' },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ dry_run = false, file_id }) => {
      const asset = resolvePdf(file_id);
      const { blank, pageCount } = await findBlankPages(asset.bytes);

      if (blank.length === 0) {
        return `No blank pages in ${asset.name}: all ${pageCount} pages have something on them.`;
      }
      if (dry_run) {
        return JSON.stringify({
          file_id: asset.id,
          blank_pages: blank,
          page_count: pageCount,
          note: 'Nothing was queued. Call again without dry_run to remove these.',
        });
      }
      if (blank.length === pageCount) {
        throw new Error('Every page is blank, and a PDF must keep at least one.');
      }

      pushOperation({
        type: 'remove_pages',
        assetIds: asset.id,
        params: { pages: blank.map((n) => n - 1) },
        summary: `Remove ${blank.length} blank page${blank.length === 1 ? '' : 's'}: ${blank.join(', ')}`,
        source: 'agent',
      });
      return `Queued removal of ${blank.length} blank page(s) from ${asset.name}: pages ${blank.join(', ')}. ${pageCount - blank.length} pages will remain.`;
    },
  },
});

declareTool({
  when: (kinds) => kinds.has('pdf'),
  definition: {
    name: 'merge_pdfs',
    description:
      'Join two or more loaded PDFs into a single document, in the order given. ' +
      'Each document keeps the changes queued against it, so pages removed from one ' +
      'are gone before it is appended. Call describe_workspace first to get the file ids. ' +
      'Like every other change this is queued, not written: the combined document ' +
      'appears on the bench and the user can undo the join to get their separate ' +
      'files back. Nothing is downloaded until they ask for it.',
    inputSchema: {
      type: 'object',
      properties: {
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description:
            'The PDFs to join, in the order they should appear. Omit to join every ' +
            'loaded PDF in the order they are on the bench.',
        },
        name: { type: 'string', description: 'Name for the combined file.' },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ file_ids, name }) => {
      const pdfs = listAssets('pdf');
      if (pdfs.length < 2) {
        throw new Error('Merging needs at least two PDFs on the bench.');
      }

      const chosen = file_ids?.length
        ? file_ids.map((id) => {
            const asset = getAsset(id);
            if (!asset || asset.kind !== 'pdf') throw new Error(`No PDF with id "${id}".`);
            return asset;
          })
        : pdfs;

      if (chosen.length < 2) throw new Error('Give at least two file ids to join.');

      window.dispatchEvent(
        new CustomEvent('keepitoffline:merge', {
          detail: { assetIds: chosen.map((a) => a.id), name },
        }),
      );

      const total = chosen.reduce((n, a) => n + a.meta.pageCount, 0);
      return `Queued a join of ${chosen.length} PDFs (about ${total} pages before any queued removals). The combined document is on the bench and the user can undo the join to get the separate files back. Nothing left the browser.`;
    },
  },
});
