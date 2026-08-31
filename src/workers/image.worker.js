// Image work: resizing, format conversion and colour grading.
//
// This is the reason the workers exist. Grading forty photographs means walking
// tens of millions of pixels, and doing that on the main thread would freeze the
// page for seconds. Here the interface stays live and the user can keep working
// while a batch runs.

/** Parsed .cube LUTs, keyed by name, so a batch parses each one once. */
const lutCache = new Map();

/**
 * Parse an Adobe .cube colour lookup table.
 *
 * The format is a header of key/value lines followed by size^3 RGB triplets,
 * with red varying fastest.
 */
function parseCube(text) {
  let size = 0;
  const table = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    // TITLE and DOMAIN_MIN/MAX carry no information we need: the domain is
    // always 0-1 for the tables we ship.
    if (/^[A-Z_]+/.test(line)) continue;

    const parts = line.split(/\s+/).map(Number);
    if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      table.push(parts[0], parts[1], parts[2]);
    }
  }

  if (!size || table.length !== size * size * size * 3) {
    throw new Error(
      `Malformed .cube file: expected ${size ** 3} entries, found ${table.length / 3}`,
    );
  }
  return { size, table: Float32Array.from(table) };
}

/** Trilinear sample of the LUT. Values in and out are 0-1. */
function sampleLut(lut, r, g, b) {
  const { size, table } = lut;
  const max = size - 1;

  const fr = r * max;
  const fg = g * max;
  const fb = b * max;

  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, max);
  const g1 = Math.min(g0 + 1, max);
  const b1 = Math.min(b0 + 1, max);

  const dr = fr - r0;
  const dg = fg - g0;
  const db = fb - b0;

  // Red varies fastest, then green, then blue.
  const at = (ri, gi, bi) => (ri + gi * size + bi * size * size) * 3;

  let out0 = 0;
  let out1 = 0;
  let out2 = 0;

  for (let corner = 0; corner < 8; corner++) {
    const useR1 = corner & 1;
    const useG1 = corner & 2;
    const useB1 = corner & 4;

    const weight =
      (useR1 ? dr : 1 - dr) * (useG1 ? dg : 1 - dg) * (useB1 ? db : 1 - db);
    if (weight === 0) continue;

    const i = at(useR1 ? r1 : r0, useG1 ? g1 : g0, useB1 ? b1 : b0);
    out0 += table[i] * weight;
    out1 += table[i + 1] * weight;
    out2 += table[i + 2] * weight;
  }

  return [out0, out1, out2];
}

/**
 * Apply a LUT to pixel data in place.
 *
 * @param {Uint8ClampedArray} data  RGBA pixels.
 * @param {number} intensity        0 leaves the image alone, 1 applies fully.
 */
function applyLut(data, lut, intensity = 1) {
  const amount = Math.min(1, Math.max(0, intensity));
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const [nr, ng, nb] = sampleLut(lut, r, g, b);

    // Blending against the original is what makes intensity meaningful, and it
    // is why "a bit of this look" is expressible at all.
    data[i] = (r + (nr - r) * amount) * 255;
    data[i + 1] = (g + (ng - g) * amount) * 255;
    data[i + 2] = (b + (nb - b) * amount) * 255;
    // Alpha is left alone: grading should not change transparency.
  }
}

/**
 * Tonal and colour adjustments, applied in one pass over the pixels.
 *
 * These live in a single operation rather than one per control: a photographer
 * thinks of "brighter, punchier, less saturated" as one adjustment, and running
 * four separate passes over forty images would cost four times as much.
 */
function applyAdjustments(data, adj) {
  const brightness = adj.brightness ?? 0; // -1..1
  const contrast = adj.contrast ?? 0; // -1..1
  const saturation = adj.saturation ?? 0; // -1..1
  const vibrance = adj.vibrance ?? 0; // -1..1

  // Standard contrast factor: maps -1..1 onto a curve through mid grey.
  const c = (contrast + 1) ** 2;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    if (brightness) {
      r += brightness;
      g += brightness;
      b += brightness;
    }

    if (contrast) {
      r = (r - 0.5) * c + 0.5;
      g = (g - 0.5) * c + 0.5;
      b = (b - 0.5) * c + 0.5;
    }

    if (saturation || vibrance) {
      const luma = LUMA.r * r + LUMA.g * g + LUMA.b * b;
      let amount = saturation;

      if (vibrance) {
        // Vibrance protects colours that are already saturated, which is what
        // keeps skin tones from going lurid.
        const current = Math.max(r, g, b) - Math.min(r, g, b);
        amount += vibrance * (1 - current);
      }

      r = luma + (r - luma) * (1 + amount);
      g = luma + (g - luma) * (1 + amount);
      b = luma + (b - luma) * (1 + amount);
    }

    data[i] = Math.min(255, Math.max(0, r * 255));
    data[i + 1] = Math.min(255, Math.max(0, g * 255));
    data[i + 2] = Math.min(255, Math.max(0, b * 255));
  }
}

const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

/** Darken towards the corners. Amount 0 does nothing, 1 is heavy. */
function applyVignette(context, width, height, amount) {
  const strength = Math.min(1, Math.max(0, amount));
  if (!strength) return;

  const gradient = context.createRadialGradient(
    width / 2, height / 2, Math.min(width, height) * 0.28,
    width / 2, height / 2, Math.max(width, height) * 0.72,
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0)');
  gradient.addColorStop(1, `rgba(0,0,0,${strength})`);

  context.save();
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.restore();
}

const WATERMARK_POSITIONS = {
  'top-left': [0, 0], 'top-center': [0.5, 0], 'top-right': [1, 0],
  'center-left': [0, 0.5], center: [0.5, 0.5], 'center-right': [1, 0.5],
  'bottom-left': [0, 1], 'bottom-center': [0.5, 1], 'bottom-right': [1, 1],
};

/** Draw a text watermark. Sized as a fraction of the image so it scales. */
function applyWatermark(context, width, height, params) {
  const text = String(params.text ?? '').trim();
  if (!text) return;

  const [ax, ay] = WATERMARK_POSITIONS[params.position] ?? WATERMARK_POSITIONS['bottom-right'];
  const opacity = Math.min(1, Math.max(0, params.opacity ?? 0.6));
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * (params.size ?? 0.05)));
  const margin = Math.round(Math.min(width, height) * 0.03);

  context.save();
  context.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  context.textBaseline = ay === 0 ? 'top' : ay === 1 ? 'bottom' : 'middle';
  context.textAlign = ax === 0 ? 'left' : ax === 1 ? 'right' : 'center';

  const x = margin + ax * (width - margin * 2);
  const y = margin + ay * (height - margin * 2);

  // A soft shadow keeps the mark readable over both light and dark areas.
  context.shadowColor = `rgba(0,0,0,${opacity * 0.6})`;
  context.shadowBlur = Math.round(fontSize * 0.25);
  context.fillStyle = `rgba(255,255,255,${opacity})`;
  context.fillText(text, x, y);
  context.restore();
}

/** Fit within a box while keeping the aspect ratio. Never enlarges. */
function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function processImage({ bytes, operations, type }) {
  let bitmap = await createImageBitmap(new Blob([bytes], { type }));
  let { width, height } = bitmap;
  let outputType = type;
  let quality = 0.9;

  // Resizing first keeps the expensive per-pixel work off pixels that are about
  // to be thrown away.
  const resize = operations.find((op) => op.type === 'resize_images');
  if (resize) {
    const fitted = fitWithin(
      width,
      height,
      resize.params.max_width ?? width,
      resize.params.max_height ?? height,
    );
    width = fitted.width;
    height = fitted.height;
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const grade = operations.find((op) => op.type === 'apply_lut');
  if (grade) {
    const lut = lutCache.get(grade.params.lut_name);
    if (!lut) throw new Error(`LUT "${grade.params.lut_name}" was not loaded`);
    const imageData = context.getImageData(0, 0, width, height);
    applyLut(imageData.data, lut, grade.params.intensity ?? 1);
    context.putImageData(imageData, 0, 0);
  }

  const adjust = operations.find((op) => op.type === 'adjust_image');
  if (adjust) {
    const imageData = context.getImageData(0, 0, width, height);
    applyAdjustments(imageData.data, adjust.params);
    context.putImageData(imageData, 0, 0);
  }

  // Vignette and watermark are drawn on top, after the pixel work, so they are
  // not themselves graded or adjusted.
  const vignette = operations.find((op) => op.type === 'apply_vignette');
  if (vignette) applyVignette(context, width, height, vignette.params.amount ?? 0.4);

  const watermark = operations.find((op) => op.type === 'add_watermark');
  if (watermark) applyWatermark(context, width, height, watermark.params);

  const convert = operations.find((op) => op.type === 'convert_format');
  if (convert) {
    outputType = `image/${convert.params.format}`;
    if (convert.params.quality != null) quality = convert.params.quality;
  }

  // PNG ignores quality; passing it anyway is harmless.
  const blob = await canvas.convertToBlob({ type: outputType, quality });
  const out = await blob.arrayBuffer();
  return { bytes: out, width, height, type: outputType, size: out.byteLength };
}

self.onmessage = async (event) => {
  const { id, action, payload } = event.data;
  try {
    switch (action) {
      case 'load_lut': {
        lutCache.set(payload.name, parseCube(payload.text));
        self.postMessage({ id, ok: true, result: { name: payload.name } });
        return;
      }
      case 'process': {
        const result = await processImage(payload);
        self.postMessage({ id, ok: true, result }, [result.bytes]);
        return;
      }
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
