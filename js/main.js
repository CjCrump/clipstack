// Entry point: wires the modules to the page and runs the render loop.

import { state, emit, uid, clampBoxes, rateAt, pieceAt, nextKept, pieces, srcToOut, outDuration, MIN_PIECE, OUT_W, fromVertical } from './state.js';
import { initCropBoxes, layout } from './cropBoxes.js';
import { initPreview, drawPreview } from './preview.js';
import { initSourceLayer, drawSourceLayer } from './sourceLayer.js';
import { initTimeline, updatePlayhead, zoomBy, zoomFit } from './timeline.js';
import { initPanel, deleteSelected } from './panel.js';
import { exportMp4, ExportError } from './exportMp4.js';
import { buildFilter, buildCommand, safeFileName } from './exportFfmpeg.js';
import { initLoader, canExportInBrowser } from './loader.js';
import { emojiReady } from './emoji.js';
import { buildEmojiPicker } from './emojiPicker.js';
import { initHints } from './hints.js';
import { showStatus } from './status.js';
import { initHistory, resetHistory, undo, redo, canUndo, canRedo, onHistoryChange } from './history.js';

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
initSourceLayer({ stage: $('stage'), canvas: $('srcLayer'), video, toggle: $('boxesToggle') });
initTimeline($('timeline'), video);
initPanel($('panel'), { onChangeEmoji: changeEmoji });
initHints();
initHistory();

// ---- undo / redo buttons ----
const syncHistoryButtons = () => {
  $('undoBtn').disabled = !state.duration || !canUndo();
  $('redoBtn').disabled = !state.duration || !canRedo();
};
onHistoryChange(syncHistoryButtons);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

// ---- quick start strip ----
// Shown until closed. Closing it is the one thing Clipstack saves in your browser.
const TIPS_KEY = 'clipstack.tipsClosed';
const tipsClosed = () => { try { return localStorage.getItem(TIPS_KEY) === '1'; } catch { return false; } };
$('tips').hidden = tipsClosed();
$('tipsClose').addEventListener('click', () => {
  $('tips').hidden = true;
  try { localStorage.setItem(TIPS_KEY, '1'); } catch { /* private mode: it just shows again next time */ }
  $('tipsBtn').focus();
});
$('tipsBtn').addEventListener('click', () => {
  $('tips').hidden = false;
  try { localStorage.removeItem(TIPS_KEY); } catch { /* ignore */ }
  $('tipsClose').focus();
});

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
    clips: [{ id: uid(), start: 0, end: video.duration, rate: 1 }],
    selected: null,
  });
  state.boxA = { x: DEFAULT_A.x * sx, y: DEFAULT_A.y * sy, w: DEFAULT_A.w * sx };
  state.boxB = { x: DEFAULT_B.x * sx, y: DEFAULT_B.y * sy, w: DEFAULT_B.w * sx };
  clampBoxes();
  $('stage').classList.add('ready');
  $('emptyMsg').hidden = true;
  ['addText', 'addEmoji', 'splitBtn', 'exportFfmpeg', 'playBtn', 'zoomIn', 'zoomOut', 'zoomFit', 'boxesToggle'].forEach((id) => { $(id).disabled = false; });
  $('exportBrowser').disabled = !canExportInBrowser();
  layout();
  zoomFit();
  emit();
  resetHistory();
});

// ---- adding items at the playhead ----
$('addText').addEventListener('click', () => {
  const t = video.currentTime;
  // new items start where they always did in the vertical preview, pinned to that spot of the footage
  const at = fromVertical(OUT_W / 2, 440);
  const item = {
    id: uid(), text: 'SPANKY', x: at.x, y: at.y, size: 160 / at.sc,
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
    const at = fromVertical(OUT_W / 2, 760);
    const item = {
      id: uid(), kind: 'emoji', file, label, x: at.x, y: at.y, size: 240 / at.sc,
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

// ---- split ----
// Cuts the piece under the playhead in two. Both halves keep its speed.
function splitAtPlayhead() {
  const t = video.currentTime;
  const p = pieceAt(t);
  if (!p || t - p.start < MIN_PIECE || p.end - t < MIN_PIECE) {
    showStatus('Move the playhead inside a piece, at least 0.1s from its edges, to split there.');
    return;
  }
  const right = { id: uid(), start: t, end: p.end, rate: p.rate };
  p.end = t;
  state.clips.push(right);
  state.selected = { type: 'clip', id: right.id };
  emit();
}
$('splitBtn').addEventListener('click', splitAtPlayhead);

$('zoomIn').addEventListener('click', () => zoomBy(1.5));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.5));
$('zoomFit').addEventListener('click', zoomFit);

// ---- playback ----
function togglePlay() {
  if (!video.paused) {
    video.pause();
    return;
  }
  // at the end of the last piece (or in a cut after it), start over from the top
  const t = nextKept(video.currentTime);
  if (t === null || srcToOut(video.currentTime) >= outDuration() - 0.02) video.currentTime = pieces()[0].start;
  else video.currentTime = t;
  video.play();
}
$('playBtn').addEventListener('click', togglePlay);
video.addEventListener('play', () => { $('playBtn').textContent = 'Pause'; });
video.addEventListener('pause', () => { $('playBtn').textContent = 'Play'; });

document.addEventListener('keydown', (e) => {
  if (!modal.hidden || !state.duration || state.exporting) return; // the dialog handles its own keys
  const ctrl = e.ctrlKey || e.metaKey;
  const typing = e.target.closest('input, textarea, select');

  // Ctrl + / - / 0 zoom the timeline instead of the page
  if (ctrl && !e.altKey && ['=', '+', '-', '_', '0'].includes(e.key)) {
    e.preventDefault();
    if (e.key === '0') zoomFit();
    else zoomBy(e.key === '-' || e.key === '_' ? 1 / 1.5 : 1.5);
    return;
  }
  // Ctrl+S and Ctrl+B split too (B is CapCut's split key), instead of Save / Bookmarks
  if (ctrl && !e.altKey && !e.shiftKey && ['s', 'b'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    if (!typing) splitAtPlayhead();
    return;
  }
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, except inside a text field, which has its own undo
  if (ctrl && !typing && ['z', 'y'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    if (e.key.toLowerCase() === 'y' || e.shiftKey) redo();
    else undo();
    return;
  }

  // fields type text; a focused button or link keeps Space and Enter for itself
  if (typing || ctrl || e.altKey) return;
  if (e.target.closest('button, a') && (e.code === 'Space' || e.key === 'Enter')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelected();
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    splitAtPlayhead();
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
// Export asks which videos to make; the choice is remembered while the page is open.
const exportChoice = { v: true, h: true };

$('exportBrowser').addEventListener('click', () => {
  if (!sourceFile) return;
  video.pause();
  openModal('Export MP4', `
    <fieldset class="export-pick">
      <legend>Which videos?</legend>
      <label data-hint="1080×1920 with the Top and Bottom crops stacked. For Shorts, Reels and TikTok.">
        <input type="checkbox" id="pickV"> Vertical <span class="muted">1080×1920</span></label>
      <label data-hint="1920×1080, the whole clip with the same cuts, speeds, text and emoji. For regular YouTube.">
        <input type="checkbox" id="pickH"> Horizontal <span class="muted">1920×1080</span></label>
    </fieldset>
    <p class="muted">Both come from one pass over your clip. If your browser asks to allow multiple downloads, say yes.</p>
    <div class="modal-actions"><button class="btn primary" id="startExport">Export</button></div>`);
  $('pickV').checked = exportChoice.v;
  $('pickH').checked = exportChoice.h;
  const sync = () => {
    exportChoice.v = $('pickV').checked;
    exportChoice.h = $('pickH').checked;
    $('startExport').disabled = !exportChoice.v && !exportChoice.h;
  };
  $('pickV').addEventListener('change', sync);
  $('pickH').addEventListener('change', sync);
  sync();
  $('startExport').addEventListener('click', () => runExport(['v', 'h'].filter((f) => exportChoice[f])));
});

async function runExport(formats) {
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
    const blobs = await exportMp4({
      file: sourceFile,
      formats,
      signal: controller.signal,
      onProgress: (p, label) => {
        $('bar').style.width = `${Math.min(100, p * 100)}%`;
        $('exportLabel').textContent = label;
      },
    });
    const base = state.fileName.replace(/\.[^.]+$/, '');
    const names = { v: 'vertical', h: 'horizontal' };
    const done = [];
    for (const f of formats) {
      download(blobs[f], `${base}_${names[f]}.mp4`);
      done.push(`${names[f]} (${(blobs[f].size / 1e6).toFixed(1)} MB)`);
    }
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    openModal('Done', '<p id="doneMsg"></p>');
    $('doneMsg').textContent = `Downloaded ${done.join(' and ')} in ${secs}s.`;
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
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$('exportFfmpeg').addEventListener('click', async () => {
  // one filter file and command per video, for whichever the export dialog has ticked
  const picks = [['v', 'vertical'], ['h', 'horizontal']].filter(([f]) => exportChoice[f]);
  if (!picks.length) picks.push(['v', 'vertical']);
  for (const [f, name] of picks) {
    download(new Blob([buildFilter(FONT_FILE, f)], { type: 'text/plain' }), `filter_${name}.txt`);
  }
  const font = await fetch(`fonts/${FONT_FILE}`).then((r) => r.blob());
  download(font, FONT_FILE);

  const safeName = safeFileName(state.fileName);
  const files = picks.map(([, name]) => `<b>filter_${name}.txt</b>`).join(', ');
  openModal('ffmpeg command', `
    <p>Downloaded ${files} and <b>${FONT_FILE}</b>. Put them in the same folder as
      <b id="cmdFile"></b>, open a terminal there, and run:</p>
    <p id="renameNote" class="notice info" hidden></p>
    <div id="cmds"></div>
    <p id="emojiNote" class="notice info" hidden>Emoji aren't included in the ffmpeg command. Use Export MP4 to keep them.</p>
    <p class="muted">Needs ffmpeg 7 or newer. Tick Vertical or Horizontal in the Export MP4 dialog to choose which commands you get.</p>`);
  $('cmdFile').textContent = state.fileName;
  if (safeName !== state.fileName) {
    $('renameNote').hidden = false;
    $('renameNote').textContent = `First rename your clip to "${safeName}". Its name has characters a terminal could treat as code.`;
  }
  $('emojiNote').hidden = !state.texts.some((t) => t.kind === 'emoji');
  for (const [, name] of picks) {
    const cmd = buildCommand(`filter_${name}.txt`, name);
    const h = document.createElement('p');
    h.className = 'cmd-label';
    h.textContent = name[0].toUpperCase() + name.slice(1);
    const pre = document.createElement('pre');
    pre.textContent = cmd;
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.textContent = `Copy ${name} command`;
    copy.dataset.hint = 'Copy this command, paste it into a terminal opened in your clip\'s folder, and press Enter.';
    copy.addEventListener('click', () => navigator.clipboard.writeText(cmd));
    $('cmds').append(h, pre, copy);
  }
});

// ---- render loop ----
const timeLabel = $('timeLabel');
function frame() {
  let t = video.currentTime;
  // playing into a deleted piece jumps over it; past the last piece, stop
  if (!video.paused && !pieceAt(t)) {
    const next = nextKept(t);
    if (next === null) {
      video.pause();
    } else {
      video.currentTime = next;
      t = next;
    }
  }
  const r = rateAt(t);
  if (video.playbackRate !== r) video.playbackRate = r;
  drawPreview();
  drawSourceLayer(t);
  updatePlayhead(t);
  timeLabel.textContent = `${srcToOut(t).toFixed(2)} / ${outDuration().toFixed(2)}`; // finished-video time
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
