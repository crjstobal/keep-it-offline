// Image tools, registered only while images are on the bench.
//
// These are where an agent earns its keep: "grade these forty photographs and
// export them at 2000px as WebP" is three tool calls here and about a hundred
// clicks anywhere else. The agent never sees a pixel: it names a look and a
// size, and the page does the work.

import { declareTool } from '../core/registry.js';
import { listAssets, pushOperation } from '../core/workspace.js';
import { availableLuts } from '../core/luts.js';

const hasImages = (kinds) => kinds.has('image');

/** Images the tool should act on: named ids, or every image loaded. */
function resolveImages(fileIds) {
  const images = listAssets('image');
  if (images.length === 0) throw new Error('No images are loaded.');
  if (!fileIds || fileIds.length === 0) return images;

  const byId = new Map(images.map((a) => [a.id, a]));
  const resolved = [];
  for (const id of fileIds) {
    const asset = byId.get(id);
    if (!asset) throw new Error(`No image with id "${id}".`);
    resolved.push(asset);
  }
  return resolved;
}

declareTool({
  when: hasImages,
  definition: {
    name: 'describe_images',
    description:
      'List the loaded images with their ids, pixel dimensions and file type. ' +
      'Call this before resizing or converting so you know what you are starting from. ' +
      'Returns JSON.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const images = listAssets('image');
      return JSON.stringify({
        count: images.length,
        images: images.map((a) => ({
          file_id: a.id,
          name: a.name,
          width: a.meta.width,
          height: a.meta.height,
          type: a.meta.type,
          orientation: a.meta.width > a.meta.height ? 'landscape' : 'portrait',
        })),
      });
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'list_looks',
    description:
      'List the colour looks (LUTs) that can be applied to images, with a short ' +
      'description of each. Call this before apply_look to find out what is available. ' +
      'Returns JSON.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    execute: async () =>
      JSON.stringify({
        looks: availableLuts().map((lut) => ({ name: lut.name, description: lut.description })),
      }),
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'resize_images',
    description:
      'Queue a resize of one or more images to fit within a box, keeping their aspect ' +
      'ratio. Images smaller than the box are left alone rather than being enlarged. ' +
      'Omit file_ids to apply to every loaded image. Adds a reversible operation to the stack.',
    inputSchema: {
      type: 'object',
      properties: {
        max_width: { type: 'integer', description: 'Maximum width in pixels.' },
        max_height: { type: 'integer', description: 'Maximum height in pixels.' },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to resize. Omit to apply to all of them.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ max_width, max_height, file_ids }) => {
      if (!max_width && !max_height) {
        throw new Error('Give at least one of max_width or max_height.');
      }
      const targets = resolveImages(file_ids);
      const box = [max_width && `${max_width}px wide`, max_height && `${max_height}px tall`]
        .filter(Boolean)
        .join(', ');

      pushOperation({
        type: 'resize_images',
        assetIds: targets.map((a) => a.id),
        params: { max_width, max_height },
        summary:
          targets.length === 1
            ? `Resize ${targets[0].name} to fit ${box}`
            : `Resize ${targets.length} images to fit ${box}`,
        source: 'agent',
      });
      return `Queued a resize of ${targets.length} image(s) to fit ${box}. Nothing has been written yet: the user can see the operations and undo any of them.`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'apply_look',
    description:
      'Queue a colour look (LUT) over one or more images, optionally at partial strength. ' +
      'Call list_looks first to see what is available. Omit file_ids to apply to every ' +
      'loaded image. The image data never leaves the browser: only the name of the look ' +
      'and the intensity are needed to do this.',
    inputSchema: {
      type: 'object',
      properties: {
        look: {
          type: 'string',
          description: 'Name of the look, as returned by list_looks.',
        },
        intensity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How strongly to apply it. 1 is full strength, 0.5 is subtle. Defaults to 1.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to grade. Omit to apply to all of them.',
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
      const targets = resolveImages(file_ids);
      const strength = Math.min(1, Math.max(0, intensity));

      const scope = targets.length === 1 ? targets[0].name : `${targets.length} images`;
      pushOperation({
        type: 'apply_lut',
        assetIds: targets.map((a) => a.id),
        params: { lut_name: look, intensity: strength },
        summary:
          strength === 1
            ? `Apply the ${look} look to ${scope}`
            : `Apply the ${look} look at ${Math.round(strength * 100)}% to ${scope}`,
        source: 'agent',
      });
      return `Queued the ${look} look over ${targets.length} image(s)${
        strength === 1 ? '' : ` at ${Math.round(strength * 100)}% strength`
      }. The pixels stayed in the browser.`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'convert_images',
    description:
      'Queue a format conversion for one or more images. Use webp or jpeg to make files ' +
      'much smaller, or png when transparency matters. Omit file_ids to convert every ' +
      'loaded image.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['webp', 'jpeg', 'png'],
          description: 'Target format.',
        },
        quality: {
          type: 'number',
          minimum: 0.1,
          maximum: 1,
          description: 'Compression quality for webp and jpeg. Defaults to 0.9. Ignored for png.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to convert. Omit to apply to all of them.',
        },
      },
      required: ['format'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ format, quality, file_ids }) => {
      const targets = resolveImages(file_ids);
      pushOperation({
        type: 'convert_format',
        assetIds: targets.map((a) => a.id),
        params: { format, quality },
        summary:
          targets.length === 1
            ? `Convert ${targets[0].name} to ${format.toUpperCase()}`
            : `Convert ${targets.length} images to ${format.toUpperCase()}`,
        source: 'agent',
      });
      return `Queued a conversion of ${targets.length} image(s) to ${format.toUpperCase()}.`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'adjust_images',
    description:
      'Queue tonal and colour adjustments over one or more images. All four controls ' +
      'run in a single pass, so pass everything you want to change in one call rather ' +
      'than calling this repeatedly. Values run from -1 to 1, where 0 changes nothing. ' +
      'Omit file_ids to apply to every loaded image.',
    inputSchema: {
      type: 'object',
      properties: {
        brightness: { type: 'number', minimum: -1, maximum: 1, description: 'Negative darkens.' },
        contrast: { type: 'number', minimum: -1, maximum: 1, description: 'Negative flattens.' },
        saturation: {
          type: 'number',
          minimum: -1,
          maximum: 1,
          description: 'Affects every colour equally. -1 is fully grey.',
        },
        vibrance: {
          type: 'number',
          minimum: -1,
          maximum: 1,
          description:
            'Like saturation, but leaves already-saturated colours alone. Safer on skin tones.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to adjust. Omit to apply to all of them.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ brightness, contrast, saturation, vibrance, file_ids }) => {
      const params = { brightness, contrast, saturation, vibrance };
      const set = Object.entries(params).filter(([, v]) => typeof v === 'number' && v !== 0);
      if (set.length === 0) {
        throw new Error('Give at least one non-zero adjustment.');
      }
      const targets = resolveImages(file_ids);
      const described = set.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ');
      const scope = targets.length === 1 ? targets[0].name : `${targets.length} images`;

      pushOperation({
        type: 'adjust_image',
        assetIds: targets.map((a) => a.id),
        params,
        summary: `Adjust ${scope}: ${described}`,
        source: 'agent',
      });
      return `Queued adjustments (${described}) over ${targets.length} image(s).`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'add_vignette',
    description:
      'Queue a vignette, darkening the corners to draw the eye towards the middle. ' +
      'Omit file_ids to apply to every loaded image.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How dark the corners go. 0.4 is a natural default, 1 is heavy.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to vignette. Omit to apply to all of them.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ amount = 0.4, file_ids }) => {
      const targets = resolveImages(file_ids);
      const strength = Math.min(1, Math.max(0, amount));
      const scope = targets.length === 1 ? targets[0].name : `${targets.length} images`;

      pushOperation({
        type: 'apply_vignette',
        assetIds: targets.map((a) => a.id),
        params: { amount: strength },
        summary: `Vignette ${scope} at ${Math.round(strength * 100)}%`,
        source: 'agent',
      });
      return `Queued a vignette over ${targets.length} image(s).`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'add_watermark',
    description:
      'Queue a text watermark over one or more images, in one of nine positions. ' +
      'The text is drawn in the browser: it is never sent anywhere. ' +
      'Omit file_ids to apply to every loaded image.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to draw.' },
        position: {
          type: 'string',
          enum: [
            'top-left', 'top-center', 'top-right',
            'center-left', 'center', 'center-right',
            'bottom-left', 'bottom-center', 'bottom-right',
          ],
          description: 'Where to place it. Defaults to bottom-right.',
        },
        opacity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'How visible the mark is. Defaults to 0.6.',
        },
        size: {
          type: 'number',
          minimum: 0.01,
          maximum: 0.3,
          description:
            'Text height as a fraction of the image, so it scales with the picture. ' +
            'Defaults to 0.05.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to mark. Omit to apply to all of them.',
        },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false },
    execute: async ({ text, position = 'bottom-right', opacity = 0.6, size = 0.05, file_ids }) => {
      if (!String(text).trim()) throw new Error('The watermark text cannot be empty.');
      const targets = resolveImages(file_ids);
      const scope = targets.length === 1 ? targets[0].name : `${targets.length} images`;

      pushOperation({
        type: 'add_watermark',
        assetIds: targets.map((a) => a.id),
        params: { text, position, opacity, size },
        summary: `Watermark ${scope} with "${text}" (${position})`,
        source: 'agent',
      });
      return `Queued a "${text}" watermark at ${position} over ${targets.length} image(s).`;
    },
  },
});

declareTool({
  when: hasImages,
  definition: {
    name: 'orient_images',
    description:
      'Queue a rotation of one or more images. Either give a specific turn in degrees, ' +
      'or ask for a shape and only the images that do not already have it are turned, ' +
      'which is what "make these all portrait" means over a mixed set. ' +
      'Omit file_ids to apply to every loaded image.',
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
          description: 'The shape the output should have. Images already that shape are skipped.',
        },
        file_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which images to turn. Omit to apply to all of them.',
        },
      },
    },
    annotations: { readOnlyHint: false },
    execute: async ({ degrees, orientation, file_ids }) => {
      if (!degrees && !orientation) {
        throw new Error('Give either degrees or an orientation.');
      }
      const targets = resolveImages(file_ids);
      const scope = targets.length === 1 ? targets[0].name : `${targets.length} images`;

      if (degrees) {
        pushOperation({
          type: 'rotate_image',
          assetIds: targets.map((a) => a.id),
          params: { degrees },
          summary: `Rotate ${scope} by ${degrees}°`,
          source: 'agent',
        });
        return `Queued a ${degrees}° rotation of ${scope}.`;
      }

      const needing = targets.filter(
        (a) => (a.meta.width >= a.meta.height ? 'landscape' : 'portrait') !== orientation,
      );
      if (needing.length === 0) {
        return `Every selected image is already ${orientation}, so there is nothing to do.`;
      }

      pushOperation({
        type: 'set_image_orientation',
        assetIds: targets.map((a) => a.id),
        params: { orientation },
        summary: `Make ${scope} ${orientation}`,
        source: 'agent',
      });
      return `Queued turning ${needing.length} of ${targets.length} image(s) to ${orientation}. The rest were already that shape.`;
    },
  },
});
