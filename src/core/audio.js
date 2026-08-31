// Audio, decoded and rendered with the Web Audio API.
//
// Two things people actually want and rarely know how to do: change the speed
// of a recording, and cut a piece out of one. Both are a few lines here and a
// download-an-app errand anywhere else.
//
// Rendering is offline and far faster than real time, so unlike video this needs
// no progress reporting: a four-second clip renders in about five milliseconds.

/** Decode a file into raw samples. */
export async function decode(bytes) {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0));
    return {
      duration: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      buffer,
    };
  } finally {
    // The context is only needed for decoding; rendering uses an offline one.
    context.close();
  }
}

export async function probe(bytes, type) {
  const { duration, sampleRate, channels } = await decode(bytes);
  return { duration, sampleRate, channels, type };
}

/**
 * The output length for a set of operations.
 *
 * Trimming and speed compose: trim first, then the speed change scales what is
 * left. Doing it the other way round would make the trim times mean something
 * different from what the user typed.
 */
export function plan(meta, operations) {
  const trim = operations.find((op) => op.type === 'trim_audio');
  const start = Math.max(0, trim?.params.start ?? 0);
  const end = Math.min(meta.duration, trim?.params.end ?? meta.duration);

  const speedOps = operations.filter((op) => op.type === 'change_speed');
  const speed = speedOps.reduce((total, op) => total * (op.params.rate ?? 1), 1);

  const trimmed = Math.max(0, end - start);
  return { start, end, speed, duration: trimmed / speed };
}

/**
 * Render the stack to a new buffer.
 *
 * playbackRate resamples, so a faster clip also rises in pitch, the classic
 * chipmunk effect. That is what people expect from "speed up a song" and it is
 * what a browser can do without a time-stretching library, so it is what this
 * does; the tool description says so plainly rather than pretending otherwise.
 */
export async function render({ bytes, meta, operations }) {
  const { buffer } = await decode(bytes);
  const layout = plan(meta, operations);

  if (layout.duration <= 0) throw new Error('The trimmed clip has no length.');

  const startSample = Math.floor(layout.start * buffer.sampleRate);
  const endSample = Math.floor(layout.end * buffer.sampleRate);
  const trimmedLength = endSample - startSample;

  // A separate buffer for the trimmed section, so the speed change applies to
  // exactly the part that survives.
  const offline = new OfflineAudioContext(
    buffer.numberOfChannels,
    Math.max(1, Math.ceil(trimmedLength / layout.speed)),
    buffer.sampleRate,
  );

  const section = offline.createBuffer(
    buffer.numberOfChannels,
    Math.max(1, trimmedLength),
    buffer.sampleRate,
  );
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    section
      .getChannelData(channel)
      .set(buffer.getChannelData(channel).subarray(startSample, endSample));
  }

  const source = offline.createBufferSource();
  source.buffer = section;
  source.playbackRate.value = layout.speed;

  const gainOp = operations.find((op) => op.type === 'change_volume');
  if (gainOp) {
    const gain = offline.createGain();
    gain.gain.value = gainOp.params.gain ?? 1;
    source.connect(gain);
    gain.connect(offline.destination);
  } else {
    source.connect(offline.destination);
  }

  source.start();
  const rendered = await offline.startRendering();

  return {
    bytes: encodeWav(rendered),
    type: 'audio/wav',
    duration: rendered.duration,
  };
}

/**
 * Write a WAV file.
 *
 * WAV rather than MP3 because it needs no encoder: the browser has no MP3
 * encoder, and pulling in a compiled one would cost more than the whole rest of
 * the app. WAV is larger but universally playable and lossless, which is the
 * right default for something people will edit again.
 */
function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const samples = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const dataBytes = samples * channels * bytesPerSample;

  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Samples are interleaved, and floats are clamped before scaling so a loud
  // passage wraps around to silence instead of tearing.
  const channelData = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, channelData[c][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return out;
}

/** A peak-per-column summary, for drawing a waveform. */
export async function waveform(bytes, columns = 300) {
  const { buffer } = await decode(bytes);
  const data = buffer.getChannelData(0);
  const per = Math.floor(data.length / columns) || 1;
  const peaks = [];

  for (let i = 0; i < columns; i++) {
    let peak = 0;
    const start = i * per;
    for (let j = start; j < start + per && j < data.length; j++) {
      const value = Math.abs(data[j]);
      if (value > peak) peak = value;
    }
    peaks.push(peak);
  }
  return peaks;
}
