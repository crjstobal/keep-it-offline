// Video tools, registered only while a video is on the bench.
//
// Video is the case where people most often give up and upload to a stranger's
// site, because the desktop tools are intimidating and the web ones all want
// the file. Trimming, turning and grading a clip are the things they actually
// want, and none of them need a server.

import { declareTool } from '../core/registry.js';
import { getAsset, listAssets, pushOperation } from '../core/workspace.js';
import { availableLuts } from '../core/luts.js';
import { plan } from '../core/video.js';

const hasVideo = (kinds) => kinds.has('video');

/**
 * How an operation should be addressed on the stack.
 *
 * A call that named no ids meant "all of them", which is a standing decision:
 * scope it to the kind so files added later arrive with it already applied. A
 * call that named ids meant those files, and stays pinned to them.
 */
function targetOf(fileIds, targets) {
  return fileIds && fileIds.length > 0
    ? { assetIds: targets.map((a) => a.id) }
    : { scope: 'video' };
}

function resolveVideos(fileIds) {
  const videos = listAssets('video');
  if (videos.length === 0) throw new Error('No videos are loaded.');
  if (!fileIds || fileIds.length === 0) return videos;

  const byId = new Map(videos.map((a) => [a.id, a]));
  return fileIds.map((id) => {
    const asset = byId.get(id);
    if (!asset) throw new Error(`No video with id "${id}".`);
    return asset;
  });
}

const scopeOf = (targets) =>
  targets.length === 1 ? targets[0].name : `${targets.length} videos`;

declareTool({
  when: hasVideo,
  definition: {
    name: 'describe_videos',
    description:
      'List the loaded videos with their ids, duration in seconds, pixel dimensions and ' +
      'orientation, plus what the output would be with the current operations applied. ' +
      'Call this before trimming so you know how long each clip is. Returns JSON.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const videos = listAssets('video');
      return JSON.stringify({
        count: videos.length,
        videos: videos.map((a) => {
          const output = plan(a.meta, []);
          return {
            file_id: a.id,
            name: a.name,
            duration_seconds: Number(a.meta.duration.toFixed(2)),
            width: a.meta.width,
            height: a.meta.height,
            orientation: a.meta.orientation,
            output: { width: output.width, height: output.height },
          };
        }),
      });
    },
  },
});

declareTool({
  when: hasVideo,
  definition: {
    name: 'trim_video',
    description:
      'Queue a trim, keeping only the section between two times in seconds. ' +
      'Call describe_videos first to find out how long the clip is. ' +
      'Omit file_ids to make it a standing rule over every loaded video, including ones the user adds later.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'number', minimum: 0, description: 'Where to start, in seconds.' },
        end: { type: 'number', minimum: 0, description: 'Where to end, in seconds.' },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which videos to trim. Omit to apply to all of them.',
        },
      },
      required: ['start', 'end'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ start, end, file_ids }) => {
      if (end <= start) throw new Error('The end time has to come after the start time.');
      const targets = resolveVideos(file_ids);

      for (const asset of targets) {
        if (start >= asset.meta.duration) {
          throw new Error(
            `${asset.name} is only ${asset.meta.duration.toFixed(1)}s long, so a start of ${start}s is past the end.`,
          );
        }
      }

      pushOperation({
        type: 'trim_video',
        assetIds: targets.map((a) => a.id),
        params: { start, end },
        summary: `Trim ${scopeOf(targets)} to ${start}s–${end}s`,
        source: 'agent',
      });
      return `Queued a trim of ${scopeOf(targets)} to the section from ${start}s to ${end}s.`;
    },
  },
});

declareTool({
  when: hasVideo,
  definition: {
    name: 'orient_video',
    description:
      'Queue a rotation of one or more videos, for clips filmed sideways. Either give a ' +
      'specific turn in degrees, or ask for a shape and only the clips that do not already ' +
      'have it are turned, which is what "make these all portrait" means over a mixed set. ' +
      'Omit file_ids to make it a standing rule over every loaded video, including ones the user adds later.',
    inputSchema: {
      type: 'object',
      properties: {
        degrees: {
          type: 'integer',
          enum: [90, 180, 270],
          description: 'A specific clockwise rotation. Use this or orientation, not both.',
        },
        orientation: {
          type: 'string',
          enum: ['portrait', 'landscape'],
          description: 'The shape the output should have. Clips already that shape are skipped.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which videos to turn. Omit to cover all of them, now and as more are added.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ degrees, orientation, file_ids }) => {
      if (!degrees && !orientation) throw new Error('Give either degrees or an orientation.');
      const targets = resolveVideos(file_ids);

      if (degrees) {
        pushOperation({
          type: 'rotate_video',
          ...targetOf(file_ids, targets),
          params: { degrees },
          summary: `Rotate ${scopeOf(targets)} by ${degrees}°`,
          source: 'agent',
        });
        return `Queued a ${degrees}° rotation of ${scopeOf(targets)}.`;
      }

      const needing = targets.filter((a) => a.meta.orientation !== orientation);
      if (needing.length === 0) {
        return `Every selected video is already ${orientation}, so there is nothing to do.`;
      }

      pushOperation({
        type: 'set_orientation',
        ...targetOf(file_ids, targets),
        params: { orientation },
        summary: `Make ${scopeOf(targets)} ${orientation}`,
        source: 'agent',
      });
      return `Queued turning ${needing.length} of ${targets.length} video(s) to ${orientation}. The rest were already that shape.`;
    },
  },
});

declareTool({
  when: hasVideo,
  definition: {
    name: 'resize_video',
    description:
      'Queue a resize of one or more videos to fit a maximum width, keeping the aspect ' +
      'ratio. Videos narrower than that are left alone. Omit file_ids to apply to all of them.',
    inputSchema: {
      type: 'object',
      properties: {
        max_width: { type: 'integer', minimum: 16, description: 'Maximum width in pixels.' },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which videos to resize. Omit to cover all of them, now and as more are added.',
        },
      },
      required: ['max_width'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ max_width, file_ids }) => {
      const targets = resolveVideos(file_ids);
      pushOperation({
        type: 'resize_video',
        ...targetOf(file_ids, targets),
        params: { max_width },
        summary: `Resize ${scopeOf(targets)} to fit ${max_width}px wide`,
        source: 'agent',
      });
      return `Queued a resize of ${scopeOf(targets)} to ${max_width}px wide.`;
    },
  },
});

declareTool({
  when: hasVideo,
  definition: {
    name: 'grade_video',
    description:
      'Queue a colour look (LUT) over one or more videos, the same looks that apply to ' +
      'images. Call list_looks to see what is available. Every frame is graded in the ' +
      'browser: the footage is never sent anywhere. Omit file_ids to apply to all of them.',
    inputSchema: {
      type: 'object',
      properties: {
        look: { type: 'string', description: 'Name of the look, as returned by list_looks.' },
        intensity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How strongly to apply it. Defaults to 1.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which videos to grade. Omit to cover all of them, now and as more are added.',
        },
      },
      required: ['look'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ look, intensity = 1, file_ids }) => {
      const known = availableLuts().map((l) => l.name);
      if (!known.includes(look)) {
        throw new Error(`Unknown look "${look}". Available: ${known.join(', ')}.`);
      }
      const targets = resolveVideos(file_ids);
      const strength = Math.min(1, Math.max(0, intensity));

      pushOperation({
        type: 'apply_lut',
        ...targetOf(file_ids, targets),
        params: { lut_name: look, intensity: strength },
        summary:
          strength === 1
            ? `Grade ${scopeOf(targets)} with the ${look} look`
            : `Grade ${scopeOf(targets)} with the ${look} look at ${Math.round(strength * 100)}%`,
        source: 'agent',
      });
      return `Queued the ${look} look over ${scopeOf(targets)}. Every frame is processed here, in the page.`;
    },
  },
});
