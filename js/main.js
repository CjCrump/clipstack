// Entry point: wires the modules to the page and runs the render loop.

import { state, emit, uid, clampBoxes, rateAt, OUT_W } from './state.js';
import { initCropBoxes, layout } from './cropBoxes.js';
import { initPreview, drawPreview } from './preview.js';
import { initTimeline, updatePlayhead } from './timeline.js';
import { initPanel, deleteSelected } from './panel.js';
import { exportMp4, ExportError } from './exportMp4.js';
import { buildFilter, buildCommand } from './exportFfmpeg.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('preview');
const FONT_FILE = 'Bangers-Regular.ttf'; // shipped in fonts/, also handed to ffmpeg
let sourceFile = null; // the loaded clip; the MP4 exporter decodes it directly

// default crops are tuned for a 1920x1080 Halo capture with the cam bottom-left
const DEFAULT_A = { x: 542, y: 41, w: 835 };
const DEFAULT_B = { x: 36, y: 730, w: 562 };

initCropBoxes({ stage: $('stage'), overlay: $('overlay'), wrap: $('sourceWrap'), readout: $('splitReadout') });
initPreview(canvas, video);
initTimeline($('timeline'), video);
initPanel($('panel'));

// Bangers ships with the app (fonts/), so every visitor gets the same text.
const fontReady = document.fonts.load('100px Bangers');

// ---- loading a clip ----
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.fileName = file.name;
  sourceFile = file;
  video.src = URL.createObjectURL(file);
});

video.addEventListener('loadedmetadata', () => {
  const sx = video.videoWidth / 1920;
  const sy = video.videoHeight / 1080;
  Object.assign(state, {
    srcW: video.videoWidth,
    srcH: video.videoHeight,
    duration: video.duration,
    texts: [],
    speeds: [],
    selected: null,
  });
  state.boxA = { x: DEFAULT_A.x * sx, y: DEFAULT_A.y * sy, w: DEFAULT_A.w * sx };
  state.boxB = { x: DEFAULT_B.x * sx, y: DEFAULT_B.y * sy, w: DEFAULT_B.w * sx };
  clampBoxes();
  $('stage').classList.add('ready');
  $('emptyMsg').hidden = true;
  ['addText', 'addSpeed', 'exportFfmpeg', 'exportBrowser', 'playBtn'].forEach((id) => { $(id).disabled = false; });
  layout();
  emit();
});

// ---- adding items at the playhead ----
$('addText').addEventListener('click', () => {
  const t = video.currentTime;
  const item = {
    id: uid(), text: 'SPANKY', x: OUT_W / 2, y: 440, size: 160,
    start: t, end: Math.min(state.duration, t + 1.4), anim: 'pop',
  };
  state.texts.push(item);
  state.selected = { type: 'text', id: item.id };
  emit();
});

$('addSpeed').addEventListener('click', () => {
  const t = video.currentTime;
  if (rateAt(t) !== 1) return; // already inside a speed segment
  const next = state.speeds.filter((s) => s.start > t).reduce((m, s) => Math.min(m, s.start), state.duration);
  const end = Math.min(next, t + 3);
  if (end - t < 0.1) return;
  const item = { id: uid(), start: t, end, rate: 4 };
  state.speeds.push(item);
  state.selected = { type: 'speed', id: item.id };
  emit();
});

// ---- playback ----
function togglePlay() {
  if (video.paused) video.play();
  else video.pause();
}
$('playBtn').addEventListener('click', togglePlay);
video.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; });
video.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || !state.duration || state.exporting) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  }
});

// ---- modal ----
const modal = $('modal');
function openModal(title, html, closable = true) {
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalClose').hidden = !closable;
  modal.hidden = false;
}
$('modalClose').addEventListener('click', () => { modal.hidden = true; });

// ---- exports ----
$('exportBrowser').addEventListener('click', async () => {
  if (!sourceFile) return;
  video.pause();
  const controller = new AbortController();
  openModal('Exporting MP4', `
    <p id="exportLabel" class="muted">Starting…</p>
    <div class="progress"><div id="bar"></div></div>
    <div class="modal-actions"><button class="btn" id="cancelExport">Cancel</button></div>`, false);
  $('cancelExport').addEventListener('click', () => controller.abort());

  state.exporting = true;
  const started = performance.now();
  try {
    await fontReady; // never bake a fallback font into the video
    const blob = await exportMp4({
      file: sourceFile,
      signal: controller.signal,
      onProgress: (p, label) => {
        $('bar').style.width = `${Math.min(100, p * 100)}%`;
        $('exportLabel').textContent = label;
      },
    });
    download(blob, `${state.fileName.replace(/\.[^.]+$/, '')}_vertical.mp4`);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    openModal('Done', `<p>Your MP4 downloaded (${(blob.size / 1e6).toFixed(1)} MB, took ${secs}s).</p>`);
  } catch (err) {
    if (err.name === 'AbortError') {
      modal.hidden = true;
    } else {
      console.error(err);
      openModal('Export failed', '<p id="exportError"></p>');
      $('exportError').textContent = err instanceof ExportError ? err.message : `Something went wrong: ${err.message}`;
    }
  } finally {
    state.exporting = false;
  }
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('exportFfmpeg').addEventListener('click', async () => {
  download(new Blob([buildFilter(FONT_FILE)], { type: 'text/plain' }), 'filter.txt');
  const font = await fetch(`fonts/${FONT_FILE}`).then((r) => r.blob());
  download(font, FONT_FILE);

  const cmd = buildCommand();
  openModal('ffmpeg command', `
    <p>Downloaded <b>filter.txt</b> and <b>${FONT_FILE}</b>. Put both in the same folder as
      <b id="cmdFile"></b>, open a terminal there, and run:</p>
    <pre id="cmd"></pre>
    <p class="muted">Needs ffmpeg 7 or newer.</p>
    <button class="btn" id="copyCmd">Copy command</button>`);
  $('cmdFile').textContent = state.fileName;
  $('cmd').textContent = cmd;
  $('copyCmd').addEventListener('click', () => navigator.clipboard.writeText(cmd));
});

// ---- render loop ----
const timeLabel = $('timeLabel');
function frame() {
  const t = video.currentTime;
  const r = rateAt(t);
  if (video.playbackRate !== r) video.playbackRate = r;
  drawPreview();
  updatePlayhead(t);
  timeLabel.textContent = `${t.toFixed(2)} / ${(state.duration || 0).toFixed(2)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
