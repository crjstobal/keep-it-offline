// Audio tools, registered only while audio is on the bench.
//
// Two tools, deliberately: speed and trim are what people look for, and every
// extra tool is one more thing for an agent to pick wrongly.

import { declareTool } from '../core/registry.js';
import { listAssets, pushOperation } from '../core/workspace.js';

const hasAudio = (kinds) => kinds.has('audio');

function resolveAudio(fileIds) {
  const tracks = listAssets('audio');
  if (tracks.length === 0) throw new Error('No audio is loaded.');
  if (!fileIds || fileIds.length === 0) return tracks;

  const byId = new Map(tracks.map((a) => [a.id, a]));
  return fileIds.map((id) => {
    const asset = byId.get(id);
    if (!asset) throw new Error(`No audio with id "${id}".`);
    return asset;
  });
}

const scopeOf = (targets) =>
  targets.length === 1 ? targets[0].name : `${targets.length} tracks`;

declareTool({
  when: hasAudio,
  definition: {
    name: 'describe_audio',
    description:
      'List the loaded audio with ids, duration in seconds, sample rate and channel count. ' +
      'Call this before trimming so you know how long each track is. Returns JSON.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const tracks = listAssets('audio');
      return JSON.stringify({
        count: tracks.length,
        tracks: tracks.map((a) => ({
          file_id: a.id,
          name: a.name,
          duration_seconds: Number(a.meta.duration.toFixed(2)),
          sample_rate: a.meta.sampleRate,
          channels: a.meta.channels,
        })),
      });
    },
  },
});

declareTool({
  when: hasAudio,
  definition: {
    name: 'change_audio_speed',
    description:
      'Queue a speed change, for example 1.25 to play a recording a quarter faster or 0.8 ' +
      'to slow it down. This shifts the pitch as well, the way a record played fast sounds ' +
      'higher: it resamples rather than time-stretching. Omit file_ids to apply to every ' +
      'loaded track.',
    inputSchema: {
      type: 'object',
      properties: {
        rate: {
          type: 'number',
          minimum: 0.25,
          maximum: 4,
          description: 'Playback rate. 1 is unchanged, 2 is twice as fast.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which tracks to change. Omit to apply to all of them.',
        },
      },
      required: ['rate'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ rate, file_ids }) => {
      if (rate === 1) throw new Error('A rate of 1 would change nothing.');
      const targets = resolveAudio(file_ids);

      pushOperation({
        type: 'change_speed',
        assetIds: targets.map((a) => a.id),
        params: { rate },
        summary: `Play ${scopeOf(targets)} at ${rate}×`,
        source: 'agent',
      });

      const example = targets[0];
      return `Queued a ${rate}× speed change over ${scopeOf(targets)}. ${example.name} goes from ${example.meta.duration.toFixed(1)}s to about ${(example.meta.duration / rate).toFixed(1)}s. The pitch shifts too.`;
    },
  },
});

declareTool({
  when: hasAudio,
  definition: {
    name: 'trim_audio',
    description:
      'Queue a trim, keeping only the section between two times in seconds. ' +
      'Call describe_audio first to find out how long the track is. ' +
      'Omit file_ids to apply to every loaded track.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', minimum: 0, description: 'Where to start, in seconds.' },
        end: { type: 'number', minimum: 0, description: 'Where to end, in seconds.' },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which tracks to trim. Omit to apply to all of them.',
        },
      },
      required: ['start', 'end'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ start, end, file_ids }) => {
      if (end <= start) throw new Error('The end time has to come after the start time.');
      const targets = resolveAudio(file_ids);

      for (const asset of targets) {
        if (start >= asset.meta.duration) {
          throw new Error(
            `${asset.name} is only ${asset.meta.duration.toFixed(1)}s long, so a start of ${start}s is past the end.`,
          );
        }
      }

      pushOperation({
        type: 'trim_audio',
        assetIds: targets.map((a) => a.id),
        params: { start, end },
        summary: `Trim ${scopeOf(targets)} to ${start}s–${end}s`,
        source: 'agent',
      });
      return `Queued a trim of ${scopeOf(targets)} to the section from ${start}s to ${end}s.`;
    },
  },
});
