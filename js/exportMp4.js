// MP4 export with WebCodecs (the browser's built-in encoders) through Mediabunny.
// Decodes the source file frame by frame, draws each output frame with the same
// code as the preview, and encodes H.264 video + AAC audio. Runs faster than real
// time where the hardware allows, keeps exact timing, and works in Firefox 130+,
// Chrome, Edge and Safari. Nothing leaves the browser.

import { state, OUT_W, OUT_H, srcToOut, outToSrc, buildSegments } from './state.js';
import { drawComposite } from './render.js';
import { timeStretch } from './timeStretch.js';

const FPS = 30;
const VIDEO_BITRATE = 12_000_000;
const AUDIO_BITRATE = 160_000;
const MB_PATH = '../vendor/mediabunny/mediabunny.min.mjs';
const AAC_PATH = '../vendor/mediabunny/mediabunny-aac-encoder.min.mjs';

export class ExportError extends Error {}

/**
 * @param {object} opts
 * @param {File} opts.file the source clip
 * @param {(fraction: number, label: string) => void} opts.onProgress
 * @param {AbortSignal} opts.signal
 * @returns {Promise<Blob>} the finished MP4
 */
export async function exportMp4({ file, onProgress, signal }) {
  onProgress(0, 'Loading encoder…');
  const mb = await import(MB_PATH); // loaded only when someone exports

  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack || !(await videoTrack.canDecode())) {
    throw new ExportError("This browser can't decode the video in this file. Try the ffmpeg command instead.");
  }
  const audioTrack = await input.getPrimaryAudioTrack();
  const hasAudio = Boolean(audioTrack && (await audioTrack.canDecode()));

  if (!(await mb.canEncodeVideo('avc', { width: OUT_W, height: OUT_H, bitrate: VIDEO_BITRATE }))) {
    throw new ExportError("This browser can't encode H.264 (MP4) video. Update it, or use the ffmpeg command.");
  }
  if (hasAudio && !(await mb.canEncodeAudio('aac'))) {
    // Firefox and Linux browsers have no built-in AAC encoder: load the bundled one.
    const { registerAacEncoder } = await import(AAC_PATH);
    registerAacEncoder();
  }

  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d', { alpha: false });

  const output = new mb.Output({
    format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new mb.BufferTarget(),
  });
  const videoSource = new mb.CanvasSource(canvas, {
    codec: 'avc',
    bitrate: VIDEO_BITRATE,
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  let audioSource = null;
  if (hasAudio) {
    audioSource = new mb.AudioBufferSource({ codec: 'aac', bitrate: AUDIO_BITRATE });
    output.addAudioTrack(audioSource);
  }

  const abort = async () => {
    await output.cancel();
    throw new DOMException('Export cancelled', 'AbortError');
  };

  try {
    await output.start();
    const outDur = srcToOut(state.duration);

    if (audioSource) {
      onProgress(0, 'Processing audio…');
      const audio = await buildAudio(mb, audioTrack, outDur, signal);
      if (signal.aborted) await abort();
      await audioSource.add(audio);
      audioSource.close();
    }

    const frames = Math.max(1, Math.floor(outDur * FPS));
    const lastSrc = state.duration - 0.001;
    const srcTimes = Array.from({ length: frames }, (_, i) => Math.min(lastSrc, outToSrc(i / FPS)));
    const sink = new mb.VideoSampleSink(videoTrack);

    let i = 0;
    let prev = null;
    for await (const sample of sink.samplesAtTimestamps(srcTimes)) {
      if (signal.aborted) {
        prev?.close();
        await abort();
      }
      const drawCrop = sample ? (c, ...rect) => sample.draw(c, ...rect) : null;
      drawComposite(ctx, drawCrop, srcTimes[i]);
      await videoSource.add(i / FPS, 1 / FPS);
      // the same frame can come back for consecutive timestamps; close it once
      if (prev && prev !== sample) prev.close();
      prev = sample;
      i++;
      if (i % 5 === 0) onProgress(i / frames, `Encoding frame ${i} of ${frames}`);
    }
    prev?.close();
    videoSource.close();

    onProgress(1, 'Finishing…');
    await output.finalize();
    return new Blob([output.target.buffer], { type: 'video/mp4' });
  } catch (err) {
    if (err.name !== 'AbortError' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw err;
  }
}

// Decode the whole audio track, then rebuild it segment by segment with the
// speed sections time-stretched, so it lines up exactly with the video.
async function buildAudio(mb, track, outDur, signal) {
  const sink = new mb.AudioBufferSink(track);
  const sr = track.sampleRate;
  const channels = Math.min(2, track.numberOfChannels);
  const total = Math.ceil(state.duration * sr);
  const src = Array.from({ length: channels }, () => new Float32Array(total));

  for await (const { buffer, timestamp } of sink.buffers()) {
    if (signal.aborted) return null;
    let off = Math.round(timestamp * sr);
    let skip = 0;
    if (off < 0) {
      skip = -off; // encoder priming before 0s
      off = 0;
    }
    if (off >= total) break;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      const n = Math.min(data.length - skip, total - off);
      if (n > 0) src[c].set(data.subarray(skip, skip + n), off);
    }
  }

  const outLen = Math.max(1, Math.round(outDur * sr));
  const out = Array.from({ length: channels }, () => new Float32Array(outLen));
  let pos = 0;
  for (const seg of buildSegments()) {
    const a = Math.round(seg.start * sr);
    const b = Math.min(total, Math.round(seg.end * sr));
    if (b <= a) continue;
    const part = src.map((c) => c.subarray(a, b));
    const res = seg.rate === 1 ? part : timeStretch(part, seg.rate);
    const n = Math.min(res[0].length, outLen - pos);
    if (n <= 0) break;
    for (let c = 0; c < channels; c++) out[c].set(res[c].subarray(0, n), pos);
    pos += n;
  }

  const audio = new AudioBuffer({ length: outLen, numberOfChannels: channels, sampleRate: sr });
  out.forEach((data, c) => audio.copyToChannel(data, c));
  return audio;
}
