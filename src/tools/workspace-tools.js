// Always-registered tools. With an empty bench these are the only two an agent
// sees, which is the honest answer to "what can you do right now".

import { declareTool } from '../core/registry.js';
import {
  getState,
  listAssets,
  operationsFor,
  setOperationEnabled,
} from '../core/workspace.js';

declareTool({
  definition: {
    name: 'describe_workspace',
    description:
      'List everything currently on the bench: the loaded files with their ids and types, ' +
      'and the queued operations. Call this first to find out what you can work with. ' +
      'Returns JSON.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const state = getState();
      return JSON.stringify({
        files: state.assets.map((a) => ({
          file_id: a.id,
          name: a.name,
          kind: a.kind,
          page_count: a.meta.pageCount,
          width: a.meta.width,
          height: a.meta.height,
        })),
        pending_operations: state.operations.map((op) => ({
          operation_id: op.id,
          file_id: op.assetId,
          type: op.type,
          summary: op.summary,
          enabled: op.enabled,
          added_by: op.source,
        })),
        note:
          state.assets.length === 0
            ? 'The bench is empty. The user needs to drop files in before anything can be done.'
            : undefined,
      });
    },
  },
});

declareTool({
  definition: {
    name: 'undo_operation',
    description:
      'Disable a queued operation by id, undoing it. The operation stays visible in the ' +
      'stack so the user can re-enable it. Use this to correct a mistake without ' +
      'discarding the rest of the work.',
    inputSchema: {
      type: 'object',
      properties: {
        operation_id: {
          type: 'string',
          description: 'Id of the operation, as returned by describe_workspace.',
        },
      },
      required: ['operation_id'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ operation_id }) => {
      const ok = setOperationEnabled(operation_id, false);
      if (!ok) throw new Error(`No operation with id "${operation_id}".`);
      return `Operation ${operation_id} is disabled. The user can re-enable it from the stack.`;
    },
  },
});

declareTool({
  when: (kinds) => kinds.size > 0,
  definition: {
    name: 'apply_and_export',
    description:
      'Apply the enabled operations to a file and hand the result to the user as a download. ' +
      'This is the only step that produces a new file. Everything stays in the browser: ' +
      'nothing is uploaded at any point.',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: 'Which file to export. Optional when only one file is loaded.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ file_id }) => {
      const assets = listAssets();
      const asset = file_id ? assets.find((a) => a.id === file_id) : assets[0];
      if (!asset) throw new Error(`No file with id "${file_id}".`);

      const ops = operationsFor(asset.id);
      if (ops.length === 0) {
        return `${asset.name} has no enabled operations, so there is nothing to apply.`;
      }

      // Export is driven by the UI so the download is tied to a user-visible
      // action rather than happening invisibly.
      window.dispatchEvent(
        new CustomEvent('keepitoffline:export', { detail: { assetId: asset.id } }),
      );
      return `Applying ${ops.length} operation(s) to ${asset.name} and preparing the download. Nothing left the browser.`;
    },
  },
});
