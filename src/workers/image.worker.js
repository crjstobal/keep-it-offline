// Image work: resizing, format conversion and colour grading.
//
// This is the reason the workers exist. Grading forty photographs means walking
// tens of millions of pixels, and doing that on the main thread would freeze the
// page for seconds. Here the interface stays live and the user can keep working
// while a batch runs.

import { applyLutToPixels, parseCube } from '../core/lut-math.js';

/** Parsed .cube LUTs, keyed by name, so a batch parses each one once. */
const lutCache = new Map();

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


/**
 * Cut the image to a shape, keeping what is inside and making the rest
 * transparent.
 *
 * Positions and sizes are fractions of the image rather than pixels, so the
 * same mask means the same thing on a thumbnail preview and on the full-size
 * export, and survives a resize queued alongside it.
 */
function applyMask(canvas, context, params) {
  const { width, height } = canvas;
  const cx = (params.x ?? 0.5) * width;
  const cy = (params.y ?? 0.5) * height;
  // The radius is a fraction of the shorter side, so a circle stays a circle.
  const r = (params.size ?? 0.4) * Math.min(width, height);

  const shape = new Path2D();
  switch (params.shape) {
    case 'square':
      shape.rect(cx - r, cy - r, r * 2, r * 2);
      break;
    case 'blob':
      traceBlob(shape, cx, cy, r, params.seed ?? 1, params.points ?? 7, params.wobble ?? 0.28);
      break;
    case 'circle':
    default:
      shape.arc(cx, cy, r, 0, Math.PI * 2);
  }

  // Keep the pixels under the shape, discard the rest.
  context.globalCompositeOperation = 'destination-in';
  context.fillStyle = '#000';
  context.fill(shape);
  context.globalCompositeOperation = 'source-over';

  if (params.border_width > 0) {
    context.lineWidth = params.border_width * Math.min(width, height) * 0.02;
    context.strokeStyle = params.border_color ?? '#ffffff';
    context.lineJoin = 'round';
    context.stroke(shape);
  }
}

/**
 * An organic closed curve: points around a circle at wobbling radii, joined
 * with smooth curves.
 *
 * The randomness is seeded so the same seed always draws the same blob, which
 * is what makes a regenerate button meaningful: each press is a new seed, and
 * the result is reproducible rather than lost.
 */
function traceBlob(path, cx, cy, radius, seed, count, wobble) {
  const random = mulberry32(seed);
  const points = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const r = radius * (1 - wobble / 2 + random() * wobble);
    points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
  }

  // Draw through the midpoints so the curve closes smoothly on itself.
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let previous = points[points.length - 1];
  let start = mid(previous, points[0]);
  path.moveTo(start.x, start.y);

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const end = mid(current, next);
    path.quadraticCurveTo(current.x, current.y, end.x, end.y);
  }
  path.closePath();
}

/** A small seeded generator, so a given seed always draws the same shape. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fit within a box while keeping the aspect ratio. Never enlarges. */
function fitWithin(width, height, maxWidth, maxHeight) {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Total rotation, and the shape it produces.
 *
 * set_orientation turns only what is not already the requested shape, which is
 * what "make these portrait" means over a mixed batch: turn the ones that need
 * it, leave the rest.
 */
function planRotation(operations, width, height) {
  let rotation = 0;
  let w = width;
  let h = height;

  for (const op of operations) {
    if (op.type === 'rotate_image') {
      rotation = (rotation + op.params.degrees) % 360;
    } else if (op.type === 'set_image_orientation') {
      const current = w >= h ? 'landscape' : 'portrait';
      if (current !== op.params.orientation) rotation = (rotation + 90) % 360;
    } else {
      continue;
    }
    [w, h] = rotation === 90 || rotation === 270 ? [height, width] : [width, height];
  }

  return { rotation, width: w, height: h };
}

async function processImage({ bytes, operations, type }) {
  let bitmap = await createImageBitmap(new Blob([bytes], { type }));
  let { width, height } = bitmap;
  let outputType = type;
  let quality = 0.9;

  const turn = planRotation(operations, width, height);

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

  // Rotation is applied while drawing, so the output canvas already has the
  // final shape and every later step sees the right dimensions.
  const quarter = turn.rotation === 90 || turn.rotation === 270;
  const outWidth = quarter ? height : width;
  const outHeight = quarter ? width : height;

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const context = canvas.getContext('2d', { willReadFrequently: true });

  if (turn.rotation) {
    context.translate(outWidth / 2, outHeight / 2);
    context.rotate((turn.rotation * Math.PI) / 180);
    context.drawImage(bitmap, -width / 2, -height / 2, width, height);
    context.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    context.drawImage(bitmap, 0, 0, width, height);
  }
  bitmap.close();

  width = outWidth;
  height = outHeight;

  const grade = operations.find((op) => op.type === 'apply_lut');
  if (grade) {
    const lut = lutCache.get(grade.params.lut_name);
    if (!lut) throw new Error(`LUT "${grade.params.lut_name}" was not loaded`);
    const imageData = context.getImageData(0, 0, width, height);
    applyLutToPixels(imageData.data, lut, grade.params.intensity ?? 1);
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

  const mask = operations.find((op) => op.type === 'apply_mask');
  if (mask) {
    applyMask(canvas, context, mask.params);
    // A cut-out needs an alpha channel, so the output has to be PNG or WebP.
    if (outputType === 'image/jpeg') outputType = 'image/png';
  }

  const watermark = operations.find((op) => op.type === 'add_watermark');
  if (watermark) applyWatermark(context, width, height, watermark.params);

  const convert = operations.find((op) => op.type === 'convert_format');
  if (convert) {
    outputType = `image/${convert.params.format}`;
    if (convert.params.quality != null) quality = convert.params.quality;
  }
  // A mask cuts holes, and JPEG has no alpha channel to hold them: choosing
  // JPEG alongside a mask would quietly fill the cut-out with black.
  if (mask && outputType === 'image/jpeg') outputType = 'image/png';

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
