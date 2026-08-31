// Video processing, in the page, with nothing downloaded and nothing uploaded.
//
// The browser already ships a decoder and an H.264 encoder, so this needs no
// ffmpeg build: a <video> element decodes, a canvas does the per-frame work, and
// MediaRecorder encodes the result. That keeps the app a few hundred kilobytes
// instead of thirty megabytes, which matters when a judge opens it cold.
//
// Unlike PDFs and images, this cannot run in a worker: <video> decoding needs
// the document. Work is therefore driven frame by frame with awaits between, so
// the interface keeps responding while a clip renders.

/** Codecs to try, best first. MP4 plays everywhere; WebM is the fallback. */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42001f',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

export function supportedMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export const isSupported = () => Boolean(supportedMime());

/** Read duration and dimensions without decoding the whole file. */
export async function probe(bytes, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('This video could not be read.'));
    });
    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      orientation: video.videoWidth >= video.videoHeight ? 'landscape' : 'portrait',
      type,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Grab one frame, for the grid thumbnail and the enlarged view. */
export async function grabFrame(bytes, type, atSeconds = 0, maxWidth = 480) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('This video could not be read.'));
    });

    video.currentTime = Math.min(atSeconds, Math.max(0, video.duration - 0.1));
    await new Promise((resolve) => {
      video.onseeked = resolve;
    });

    const scale = Math.min(maxWidth / video.videoWidth, 1);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * The output size for a given source and set of operations.
 *
 * Rotation by a quarter turn swaps width and height. A requested orientation is
 * honoured by rotating when the source does not already match it, which is what
 * "make these portrait" should mean: turn the ones that need turning, and leave
 * the rest alone.
 */
export function plan(meta, operations) {
  let { width, height } = meta;
  let rotation = 0;

  for (const op of operations) {
    if (op.type === 'rotate_video') {
      rotation = (rotation + op.params.degrees) % 360;
    } else if (op.type === 'set_orientation') {
      const wanted = op.params.orientation;
      const current = width >= height ? 'landscape' : 'portrait';
      if (current !== wanted) rotation = (rotation + 90) % 360;
    }
    if (rotation === 90 || rotation === 270) {
      [width, height] = [meta.height, meta.width];
    } else {
      [width, height] = [meta.width, meta.height];
    }
  }

  const resize = operations.find((op) => op.type === 'resize_video');
  if (resize?.params.max_width && width > resize.params.max_width) {
    const scale = resize.params.max_width / width;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  // Encoders reject odd dimensions for H.264, and a silent failure here is
  // worse than a pixel of cropping.
  width -= width % 2;
  height -= height % 2;

  const trim = operations.find((op) => op.type === 'trim_video');
  const start = Math.max(0, trim?.params.start ?? 0);
  const end = Math.min(meta.duration, trim?.params.end ?? meta.duration);

  return { width, height, rotation, start, end, duration: Math.max(0, end - start) };
}

/**
 * Render a clip with the stack applied.
 *
 * @param {Object} options
 * @param {ArrayBuffer} options.bytes
 * @param {string} options.type
 * @param {Object} options.meta
 * @param {Array} options.operations
 * @param {(fraction: number) => void} [options.onProgress]
 * @param {(data: Uint8ClampedArray) => void} [options.gradeFrame]  Per-frame pixel work.
 * @param {AbortSignal} [options.signal]
 */
export async function render({ bytes, type, meta, operations, onProgress, gradeFrame, signal }) {
  const mime = supportedMime();
  if (!mime) throw new Error('This browser cannot encode video.');

  const layout = plan(meta, operations);
  if (layout.duration <= 0) throw new Error('The trimmed clip has no length.');

  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const video = document.createElement('video');
  video.muted = true;
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('This video could not be read.'));
    });

    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const context = canvas.getContext('2d', { willReadFrequently: Boolean(gradeFrame) });

    // captureStream(0) hands over frame timing, but MediaRecorder still stamps
    // each frame with wall-clock time. Stepping through the source faster than
    // real time therefore produces a clip shorter than the section asked for,
    // so each frame is held for its own share of the timeline.
    const fps = 30;
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
    recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    const finished = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start();

    // Stepping frame by frame rather than playing lets a trim start anywhere and
    // keeps the result independent of decoding speed.
    const total = Math.ceil(layout.duration * fps);
    const frameMs = 1000 / fps;
    const startedAt = performance.now();

    for (let frame = 0; frame < total; frame++) {
      if (signal?.aborted) {
        recorder.stop();
        throw new DOMException('Rendering cancelled', 'AbortError');
      }

      video.currentTime = layout.start + frame / fps;
      await new Promise((resolve) => {
        video.onseeked = resolve;
      });

      drawFrame(context, video, layout);

      if (gradeFrame) {
        const image = context.getImageData(0, 0, layout.width, layout.height);
        gradeFrame(image.data);
        context.putImageData(image, 0, 0);
      }

      track.requestFrame();
      onProgress?.((frame + 1) / total);

      // Hold each frame for its slot on the recording timeline. This also
      // yields, so the page keeps painting during a long clip.
      const dueAt = startedAt + (frame + 1) * frameMs;
      const wait = Math.max(0, dueAt - performance.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    recorder.stop();
    await finished;

    const blob = new Blob(chunks, { type: mime });
    return {
      bytes: await blob.arrayBuffer(),
      type: mime.split(';')[0],
      width: layout.width,
      height: layout.height,
      duration: layout.duration,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Draw the source into the output canvas, applying rotation and fit. */
function drawFrame(context, video, layout) {
  const { width, height, rotation } = layout;
  context.save();
  context.clearRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  if (rotation) context.rotate((rotation * Math.PI) / 180);

  // After a quarter turn the drawing axes are swapped, so fit against the
  // dimension the source will actually occupy.
  const quarter = rotation === 90 || rotation === 270;
  const boxWidth = quarter ? height : width;
  const boxHeight = quarter ? width : height;
  const scale = Math.min(boxWidth / video.videoWidth, boxHeight / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;

  context.drawImage(video, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
  context.restore();
}
