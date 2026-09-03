// Always-registered tools. With an empty bench these are the only two an agent
// sees, which is the honest answer to "what can you do right now".

import { declareTool } from '../core/registry.js';
import {
  clearSelection,
  getState,
  isJoinProduct,
  isSelected,
  listAssets,
  operationsFor,
  selectedAssets,
  setOperationEnabled,
  setSelection,
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
      const picked = selectedAssets();
      return JSON.stringify({
        files: state.assets.map((a) => ({
          file_id: a.id,
          name: a.name,
          kind: a.kind,
          // What the user has picked out by hand. When they say "just these",
          // or "the ones I selected", these are the ones they mean.
          selected: isSelected(a.id),
          page_count: a.meta.pageCount,
          width: a.meta.width,
          height: a.meta.height,
        })),
        selection: {
          file_ids: picked.map((a) => a.id),
          note:
            picked.length === 0
              ? 'The user has not picked any files out, so their controls act on every file of a kind. Pass file_ids yourself to narrow a tool.'
              : 'The user picked these out by hand. Unless they say otherwise, pass exactly these as file_ids.',
        },
        // A kind-scoped operation covers whatever is loaded now, so it is
        // reported by the files it actually covers rather than by an id list it
        // does not keep. `applies_to` tells the agent it will also catch files
        // the user adds later, which changes what it should do about it.
        pending_operations: state.operations.map((op) => ({
          operation_id: op.id,
          file_ids: op.scope
            ? state.assets.filter((a) => a.kind === op.scope).map((a) => a.id)
            : op.assetIds,
          applies_to: op.scope ? `every ${op.scope} on the bench, including ones added later` : 'the listed files',
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

// Narrowing is meaningless with one file, and the tool catalogue is paid for on
// every request: this one earns its slot only once there is a choice to make.
declareTool({
  when: () => listAssets().length > 1,
  definition: {
    name: 'select_files',
    description:
      'Pick files out on screen, the same selection the user makes by clicking them. ' +
      'The user can see what you picked and change it. Use this when they ask to work on ' +
      'a subset ("just the sideways ones") so the choice is visible before anything is ' +
      'changed, then pass the same ids as file_ids to the tool that does the work. ' +
      'Pass an empty list to clear the selection, which puts their controls back to ' +
      'covering every file.',
    inputSchema: {
      type: 'object',
      properties: {
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ids from describe_workspace. An empty array clears the selection.',
        },
      },
      required: ['file_ids'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ file_ids }) => {
      if (!Array.isArray(file_ids)) throw new Error('file_ids must be an array of file ids.');

      if (file_ids.length === 0) {
        clearSelection();
        return 'Cleared the selection. The user\'s controls act on every file of a kind again.';
      }

      const assets = listAssets();
      const unknown = file_ids.filter((id) => !assets.some((a) => a.id === id));
      if (unknown.length > 0) {
        throw new Error(
          `No file with id ${unknown.map((id) => `"${id}"`).join(', ')}. Call describe_workspace for the current ids.`,
        );
      }

      setSelection(file_ids);
      const names = listAssets()
        .filter((a) => file_ids.includes(a.id))
        .map((a) => a.name);
      return `Selected ${names.length} file(s) on screen: ${names.join(', ')}. The user can see the selection and change it.`;
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

      // A document produced by a join already carries its changes in its bytes,
      // so it is exportable with an empty stack. Only a file that is both
      // untouched and unqueued has nothing to give.
      const ops = operationsFor(asset.id);
      const baked = isJoinProduct(asset.id);
      if (ops.length === 0 && !baked) {
        return `${asset.name} has no enabled operations, so there is nothing to apply.`;
      }

      // Export is driven by the UI so the download is tied to a user-visible
      // action rather than happening invisibly.
      window.dispatchEvent(
        new CustomEvent('keepitoffline:export', { detail: { assetId: asset.id } }),
      );
      return ops.length === 0
        ? `Preparing the download for ${asset.name}, which already carries the changes that were joined into it. Nothing left the browser.`
        : `Applying ${ops.length} operation(s) to ${asset.name} and preparing the download. Nothing left the browser.`;
    },
  },
});
