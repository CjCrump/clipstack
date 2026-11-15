// Entry point: wires the modules to the page and runs the render loop.

import { state, emit, uid, clampBoxes, rateAt, OUT_W } from './state.js';
import { initCropBoxes, layout } from './cropBoxes.js';
import { initPreview, drawPreview } from './preview.js';
import { initTimeline, updatePlayhead } from './timeline.js';
import { initPanel, deleteSelected } from './panel.js';
import { exportMp4, ExportError } from './exportMp4.js';
import { buildFilter, buildCommand, safeFileName } from './exportFfmpeg.js';
import { initLoader, canExportInBrowser } from './loader.js';
import { emojiReady } from './emoji.js';
import { buildEmojiPicker } from './emojiPicker.js';

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
initPanel($('panel'), { onChangeEmoji: changeEmoji });

// Bangers ships with the app (fonts/), so every visitor gets the same text.
const fontReady = document.fonts.load('100px Bangers');

// ---- notices (errors and info) ----
const notice = $('notice');
function showNotice(message, kind = 'info') {
  notice.hidden = !message;
  notice.textContent = message || '';
  notice.className = `notice ${kind}`;
}

if (!canExportInBrowser()) {
  showNotice('Export MP4 needs Firefox 130+, Chrome or Edge 94+, or Safari 26+. You can still edit here and use the ffmpeg command.');
}

// ---- loading a clip ----
initLoader({
  video,
  input: $('fileInput'),
  dropZone: document.body,
  notice: showNotice,
  onFile: (file) => {
    state.fileName = file.name;
    sourceFile = file;
  },
});

video.addEventListener('loadedmetadata', () => {
  if (!video.videoWidth) return; // loader shows the error
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
  ['addText', 'addEmoji', 'addSpeed', 'exportFfmpeg', 'playBtn'].forEach((id) => { $(id).disabled = false; });
  $('exportBrowser').disabled = !canExportInBrowser();
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

// Emoji open the picker; the pick lands at the playhead like a text does.
function pickEmoji(title, onPick) {
  openModal(title, '');
  buildEmojiPicker($('modalBody'), (pick) => {
    closeModal();
    onPick(pick);
  });
}

$('addEmoji').addEventListener('click', () => {
  const t = video.currentTime;
  pickEmoji('Add emoji', ({ file, label }) => {
    const item = {
      id: uid(), kind: 'emoji', file, label, x: OUT_W / 2, y: 760, size: 240,
      start: t, end: Math.min(state.duration, t + 1.4), anim: 'pop',
    };
    state.texts.push(item);
    state.selected = { type: 'text', id: item.id };
    emit();
  });
});

function changeEmoji(item) {
  pickEmoji('Change emoji', ({ file, label }) => {
    Object.assign(item, { file, label });
    emit();
  });
}

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
  if (!modal.hidden) return; // the dialog handles its own keys
  // fields type text; buttons and links use Space/Enter themselves
  if (e.target.closest('input, textarea, select, button, a') || !state.duration || state.exporting) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  }
});

// ---- modal ----
// A real dialog for keyboard users: focus moves in, Tab stays inside, Esc closes,
// and focus goes back to whatever opened it.
const modal = $('modal');
let returnFocus = null;
const focusables = () => [...modal.querySelectorAll('button, a[href], input, [tabindex="0"]')]
  .filter((el) => !el.hidden && !el.disabled && el.offsetParent !== null);

function openModal(title, html, closable = true) {
  if (modal.hidden) returnFocus = document.activeElement;
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalClose').hidden = !closable;
  modal.hidden = false;
  (closable ? $('modalClose') : focusables()[0])?.focus();
}

function closeModal() {
  modal.hidden = true;
  returnFocus?.focus?.();
  returnFocus = null;
}
$('modalClose').addEventListener('click', closeModal);

modal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modalClose').hidden) {
    e.preventDefault();
    closeModal();
  } else if (e.key === 'Tab') {
    const els = focusables();
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
});

$('keysBtn').addEventListener('click', () => {
  openModal('Keyboard shortcuts', '');
  $('modalBody').appendChild($('keysTemplate').content.cloneNode(true));
});

$('loadBtn').addEventListener('click', () => $('fileInput').click());

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
    await emojiReady(state.texts.filter((t) => t.kind === 'emoji').map((t) => t.file)); // or a missing emoji
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
      closeModal();
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
  const safeName = safeFileName(state.fileName);
  openModal('ffmpeg command', `
    <p>Downloaded <b>filter.txt</b> and <b>${FONT_FILE}</b>. Put both in the same folder as
      <b id="cmdFile"></b>, open a terminal there, and run:</p>
    <p id="renameNote" class="notice info" hidden></p>
    <pre id="cmd"></pre>
    <p id="emojiNote" class="notice info" hidden>Emoji aren't included in the ffmpeg command. Use Export MP4 to keep them.</p>
    <p class="muted">Needs ffmpeg 7 or newer.</p>
    <button class="btn" id="copyCmd">Copy command</button>`);
  $('cmdFile').textContent = state.fileName;
  if (safeName !== state.fileName) {
    $('renameNote').hidden = false;
    $('renameNote').textContent = `First rename your clip to "${safeName}". Its name has characters a terminal could treat as code.`;
  }
  $('emojiNote').hidden = !state.texts.some((t) => t.kind === 'emoji');
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
