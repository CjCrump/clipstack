// In-browser export: plays the clip once in real time and records the preview canvas
// plus audio. Speed segments come along for free because the video really plays faster.

import { state } from './state.js';
import { ensureAudio } from './audio.js';

const MIME_TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2', // H.264 MP4, what socials want
  'video/mp4;codecs=avc1.640028,opus',
  'video/webm;codecs=vp9,opus',
  'video/webm',
];

const once = (target, evt) => new Promise((res) => target.addEventListener(evt, res, { once: true }));

export async function exportBrowser({ video, canvas, onProgress }) {
  const { dest } = ensureAudio(video);
  const mimeType = MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m)) || '';

  const stream = new MediaStream([
    ...canvas.captureStream(30).getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  const rec = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 16_000_000,
    audioBitsPerSecond: 160_000,
  });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  state.exporting = true;
  video.pause();
  video.currentTime = 0;
  await once(video, 'seeked');

  rec.start(500);
  await video.play();
  await new Promise((res) => {
    const tick = () => {
      onProgress(video.currentTime / state.duration);
      if (video.ended || video.paused) res();
      else requestAnimationFrame(tick);
    };
    tick();
  });
  rec.stop();
  await once(rec, 'stop');
  state.exporting = false;

  const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.fileName.replace(/\.[^.]+$/, '')}_vertical.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return ext;
}
