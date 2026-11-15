// Timeline, drawn in output time (the finished video): deleted pieces are gone and
// sped-up pieces are shorter, so what you see here is what you export.
//
// Rows: a ruler (the playhead slider), the Clip row (one bar per kept piece), then
// one row per text or emoji. Text and emoji are stored in source time so they stay
// on the moment they were placed on, and are converted here for display.
//
// Mouse: drag a text/emoji bar to move it, drag its edges to trim; edges snap to
// clip splits and the playhead. Click a clip piece to select it. Click or drag on
// the ruler or an empty track to move the playhead. Mouse wheel scrolls left and
// right (or through the rows if there's nothing to scroll sideways), Shift + wheel
// scrolls the rows, Ctrl + wheel zooms. The bar on top scrolls sideways too.
// Keyboard: see onRulerKey / onBarKey / onPieceKey. Ctrl + and - zoom (main.js).

import {
  state, emit, subscribe, clamp, srcToOut, outToSrc, outDuration, pieceEdgesOut, pieces,
} from './state.js';

const MIN_LEN = 0.1; // shortest text/emoji, output seconds
const FRAME = 1 / 30;
const SNAP_PX = 8;
const FRAME_PX_AT_MAX = 40; // fully zoomed in, one frame is this wide

// Ruler scales, finest first. Each has labelled major ticks, small ticks between
// them, and sometimes a medium tick halfway. Zooming in walks down this list:
// 10s with a tick per second, 1s with a tick per tenth, down to one tick per frame.
const F = FRAME;
const SCALES = [
  { major: 2 * F, minor: F },
  { major: 5 * F, minor: F },
  { major: 10 * F, minor: F, mid: 5 * F },
  { major: 0.5, minor: 0.1 },
  { major: 1, minor: 0.1, mid: 0.5 },
  { major: 2, minor: 0.2, mid: 1 },
  { major: 5, minor: 1 },
  { major: 10, minor: 1, mid: 5 },
  { major: 30, minor: 5, mid: 15 },
  { major: 60, minor: 10, mid: 30 },
  { major: 300, minor: 60 },
  { major: 600, minor: 60, mid: 300 },
];
const MAJOR_MIN_PX = 80; // room for a label

let root, video, playhead, head, snapLine, ruler, rulerCanvas, content, topBar;
let lastAriaT = -1;
let structureKey = '';
let zoom = 1;
const bars = new Map(); // "type:id" -> element

export function initTimeline(el, v, top) {
  root = el;
  video = v;
  topBar = top;
  subscribe(render);
  new ResizeObserver(() => { structureKey = ''; render(); }).observe(root);
  root.addEventListener('wheel', onWheel, { passive: false });
  topBar.addEventListener('wheel', onWheel, { passive: false });
  initTopBar();
}

// ---- scrub bar on top ----
// The whole video, end to end. The red knob is the playhead: click or drag
// anywhere on the bar to move it. When zoomed in, the lighter box shows the part
// of the video in view; drag it to scroll. With the whole video in view, the bar
// lines up with the timeline, so the knob sits right above the red line.
const contentW = () => outDuration() * pxPerSec();
const maxScroll = () => Math.max(0, contentW() - viewW());

function initTopBar() {
  const win = topBar.querySelector('.tl-window');
  root.addEventListener('scroll', () => { syncOverview(); drawRuler(); });
  new ResizeObserver(syncOverview).observe(topBar);

  // drag the view box: scroll
  win.addEventListener('pointerdown', (e) => {
    if (!state.duration) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const s0 = root.scrollLeft;
    win.setPointerCapture(e.pointerId);
    const move = (ev) => { root.scrollLeft = s0 + ((ev.clientX - x0) / topBar.clientWidth) * contentW(); };
    const up = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
  });

  // anywhere else on the bar (knob included): move the playhead there
  topBar.addEventListener('pointerdown', (e) => {
    if (!state.duration || e.target === win) return;
    e.preventDefault();
    const seek = (ev) => {
      const r = topBar.getBoundingClientRect();
      seekOut(onFrame(clamp((ev.clientX - r.left) / r.width, 0, 1) * outDuration()));
      keepPlayheadInView();
    };
    seek(e);
    topBar.setPointerCapture(e.pointerId);
    const up = () => {
      topBar.removeEventListener('pointermove', seek);
      topBar.removeEventListener('pointerup', up);
    };
    topBar.addEventListener('pointermove', seek);
    topBar.addEventListener('pointerup', up);
  });

  win.addEventListener('keydown', (e) => {
    const page = viewW();
    const by = { ArrowLeft: -page / 10, ArrowRight: page / 10, PageUp: -page, PageDown: page }[e.key];
    if (by !== undefined) root.scrollLeft += by;
    else if (e.key === 'Home') root.scrollLeft = 0;
    else if (e.key === 'End') root.scrollLeft = maxScroll();
    else return;
    e.preventDefault();
  });
}

function syncOverview() {
  if (!topBar) return;
  const win = topBar.querySelector('.tl-window');
  const knob = topBar.querySelector('.tl-knob');
  topBar.hidden = !state.duration;
  if (!state.duration) return;
  // match the timeline's width exactly (its row scrollbar, if any, takes space on the right)
  topBar.style.marginRight = `${root.offsetWidth - root.clientWidth}px`;
  const track = topBar.clientWidth;
  const total = Math.max(0.001, contentW());
  const share = Math.min(1, viewW() / total);
  win.hidden = share >= 1; // nothing to scroll: no box
  win.style.width = `${Math.max(16, track * share)}px`;
  win.style.left = `${(root.scrollLeft / total) * track}px`;
  win.setAttribute('aria-valuenow', String(maxScroll() ? Math.round((root.scrollLeft / maxScroll()) * 100) : 0));
  knob.style.left = `${(outNow() / Math.max(0.001, outDuration())) * track}px`;
}

// If the playhead has gone off screen, scroll so it's back in view.
function keepPlayheadInView() {
  const x = outNow() * pxPerSec();
  const pad = 30;
  if (x < root.scrollLeft + pad) root.scrollLeft = Math.max(0, x - pad);
  else if (x > root.scrollLeft + viewW() - pad) root.scrollLeft = Math.min(maxScroll(), x - viewW() + pad);
}

// Wheel: Ctrl zooms; otherwise sideways through time, or through the rows when
// the whole video already fits (or with Shift).
function onWheel(e) {
  if (!state.duration) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault(); // otherwise the browser zooms the page
    zoomBy(e.deltaY < 0 ? 1.25 : 0.8, e.clientX);
    return;
  }
  // Firefox reports wheel steps in lines, Chrome in pixels
  const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? viewW() : 1;
  const along = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
  const canSideways = outDuration() * pxPerSec() > viewW() + 1; // zoomed in past the view
  if (e.shiftKey || !canSideways) {
    if (root.scrollHeight <= root.clientHeight + 1) return; // nothing to scroll
    e.preventDefault();
    root.scrollTop += along;
  } else {
    e.preventDefault();
    root.scrollLeft += along;
  }
}

// ---- geometry ----
const labelW = () => parseFloat(getComputedStyle(root).getPropertyValue('--label-w')) || 90;
const viewW = () => Math.max(50, root.clientWidth - labelW());
const pxPerSec = () => (state.duration ? (viewW() * zoom) / Math.max(0.1, outDuration()) : 1);
const outNow = () => srcToOut(video.currentTime);

// ---- zoom ----
// Zooming stops once a single frame is FRAME_PX_AT_MAX wide, whatever the clip length.
const maxZoom = () => Math.max(1, (FRAME_PX_AT_MAX / FRAME) / (viewW() / Math.max(0.1, outDuration())));
// Zoom keeps the point under the mouse (or the playhead) where it was on screen.
export function zoomBy(factor, clientX) {
  if (!state.duration) return;
  const anchorOut = clientX === undefined
    ? outNow()
    : (clientX - root.getBoundingClientRect().left - labelW() + root.scrollLeft) / pxPerSec();
  const screenX = anchorOut * pxPerSec() - root.scrollLeft;
  zoom = clamp(zoom * factor, 1, maxZoom());
  structureKey = ''; // ticks depend on zoom
  render();
  root.scrollLeft = Math.max(0, anchorOut * pxPerSec() - screenX);
}
export function zoomFit() {
  zoom = 1;
  structureKey = '';
  render();
  root.scrollLeft = 0;
}

export function updatePlayhead(t) {
  if (!playhead) return;
  const x = srcToOut(t) * pxPerSec();
  playhead.style.left = `${x}px`;
  if (head) head.style.left = `${x}px`;
  syncOverview();
  // while playing zoomed in, page the view along with the playhead
  if (!video.paused && zoom > 1 && (x < root.scrollLeft || x > root.scrollLeft + viewW() - 20)) {
    root.scrollLeft = Math.max(0, x - 40);
  }
  const o = srcToOut(t);
  if (ruler && Math.abs(o - lastAriaT) > 0.05) {
    lastAriaT = o;
    ruler.setAttribute('aria-valuenow', o.toFixed(2));
    ruler.setAttribute('aria-valuetext', `${o.toFixed(1)} seconds`);
  }
}

function render() {
  const key = `${state.duration}|${pieces().map((p) => `${p.id}:${p.rate}`)}|${state.texts.map((t) => t.id)}|${zoom}`;
  if (key !== structureKey) {
    structureKey = key;
    build();
  }
  layoutBars();
}

function build() {
  // rebuilding replaces the elements, so put keyboard focus back where it was
  const focusedKey = root.contains(document.activeElement) ? document.activeElement.dataset.tlKey : null;
  const scroll = root.scrollLeft;
  root.innerHTML = '';
  bars.clear();
  ruler = null;
  if (!state.duration) return;

  const width = Math.ceil(outDuration() * pxPerSec());
  root.style.setProperty('--tl-w', `${width}px`);
  content = document.createElement('div');
  content.className = 'tl-content';
  root.appendChild(content);

  content.appendChild(rulerRow());
  content.appendChild(clipRow());
  const counts = { text: 0, emoji: 0 };
  state.texts.forEach((t) => {
    const kind = t.kind === 'emoji' ? 'emoji' : 'text';
    counts[kind]++;
    content.appendChild(lane(`${kind === 'emoji' ? 'Emoji' : 'Text'} ${counts[kind]}`, t));
  });

  const layer = document.createElement('div');
  layer.className = 'tl-playhead-layer';
  playhead = document.createElement('div');
  playhead.className = 'tl-playhead';
  snapLine = document.createElement('div');
  snapLine.className = 'tl-snap';
  snapLine.hidden = true;
  layer.append(snapLine, playhead);
  content.appendChild(layer);

  root.scrollLeft = scroll;
  syncOverview();
  drawRuler();
  const refocus = focusedKey === 'ruler' ? ruler : bars.get(focusedKey);
  refocus?.focus();
  updatePlayhead(video.currentTime);
}

function row(labelText, cls = '') {
  const r = document.createElement('div');
  r.className = `tl-row ${cls}`;
  const label = document.createElement('div');
  label.className = 'tl-label';
  label.textContent = labelText;
  const track = document.createElement('div');
  track.className = 'tl-track';
  track.addEventListener('pointerdown', scrub);
  r.append(label, track);
  return { r, track };
}

function rulerRow() {
  const { r, track } = row('', 'ruler');
  ruler = track;
  track.tabIndex = 0;
  track.dataset.tlKey = 'ruler';
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', 'Playhead');
  track.dataset.hintFocus = 'only';
  track.dataset.hint = 'Click or drag to move the playhead. Arrows step 0.1s, comma and period step one frame, Home and End jump. Ctrl + and - zoom.';
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', outDuration().toFixed(2));
  track.addEventListener('keydown', onRulerKey);
  // the playhead's handle: lives in the ruler, which stays on top while rows scroll
  head = document.createElement('div');
  head.className = 'tl-head';
  head.dataset.hint = 'The playhead. Drag it to scrub; the timeline follows when you drag past the edge.';
  track.appendChild(head);
  lastAriaT = -1;
  // ticks are drawn on a canvas covering just the visible part (see drawRuler)
  rulerCanvas = document.createElement('canvas');
  rulerCanvas.className = 'tl-ruler-canvas';
  rulerCanvas.setAttribute('aria-hidden', 'true');
  track.appendChild(rulerCanvas);
  return r;
}

// Time label for a major tick: seconds (m:ss past a minute), tenths below a second,
// and seconds + frame number at frame scale ("1:01 12f").
const fmtSec = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}s`);
function tickLabel(t, scale) {
  const frames = Math.round(t / FRAME);
  const sec = Math.floor(frames * FRAME + 1e-6);
  if (scale.major < 0.5) {
    const f = frames - Math.round(sec / FRAME);
    return f ? `${fmtSec(sec)} ${f}f` : fmtSec(sec);
  }
  if (scale.major < 1) {
    const tenth = Math.round((t - sec) * 10);
    return sec >= 60 ? `${fmtSec(sec)}.${tenth}` : `${sec}.${tenth}s`;
  }
  return fmtSec(Math.round(t));
}

// A real ruler: line along the top, ticks hanging down, numbers underneath.
function drawRuler() {
  if (!rulerCanvas || !state.duration) return;
  const dpr = window.devicePixelRatio || 1;
  const w = viewW();
  const h = ruler.clientHeight || 32;
  if (rulerCanvas.width !== Math.round(w * dpr) || rulerCanvas.height !== Math.round(h * dpr)) {
    rulerCanvas.width = Math.round(w * dpr);
    rulerCanvas.height = Math.round(h * dpr);
    rulerCanvas.style.width = `${w}px`;
    rulerCanvas.style.height = `${h}px`;
  }
  rulerCanvas.style.left = `${root.scrollLeft}px`; // follows the view
  const c = rulerCanvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);

  const pps = pxPerSec();
  const scale = SCALES.find((sc) => sc.major * pps >= MAJOR_MIN_PX) || SCALES[SCALES.length - 1];
  const showMinor = scale.minor * pps >= 4;
  const t0 = root.scrollLeft / pps;
  const t1 = Math.min(outDuration(), (root.scrollLeft + w) / pps);
  const muted = getComputedStyle(root).getPropertyValue('--muted').trim() || '#9aa0a6';
  const text = getComputedStyle(root).getPropertyValue('--text').trim() || '#e8e8ea';

  // baseline along the top
  c.fillStyle = muted;
  c.fillRect(0, 0, w, 1);

  // ticks are counted in minor steps so frame ticks never drift
  const per = Math.round(scale.major / scale.minor);
  const midEvery = scale.mid ? Math.round(scale.mid / scale.minor) : 0;
  const first = Math.max(0, Math.floor(t0 / scale.minor) - 1);
  const last = Math.ceil(t1 / scale.minor) + 1;
  c.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  c.textBaseline = 'top';
  for (let i = first; i <= last; i++) {
    const t = i * scale.minor;
    if (t > outDuration() + 1e-6) break;
    const x = Math.round(t * pps - root.scrollLeft) + 0.5;
    if (x < -40 || x > w + 40) continue;
    const isMajor = i % per === 0;
    const isMid = !isMajor && midEvery && i % midEvery === 0;
    if (!isMajor && !isMid && !showMinor) continue;
    const len = isMajor ? 12 : isMid ? 8 : 5;
    c.fillStyle = isMajor ? text : muted;
    c.fillRect(Math.floor(x), 1, 1, len);
    if (isMajor) {
      c.fillStyle = muted;
      c.fillText(tickLabel(t, scale), Math.floor(x) + 3, 15);
    }
  }
}

function clipRow() {
  const { r, track } = row('Clip', 'clip');
  pieces().forEach((p, i) => {
    const bar = makeBar('clip', p, i % 2 ? 'alt' : '');
    bar.dataset.hint = 'A piece of your clip. Select it to change its speed or delete it. S splits at the playhead.';
    bar.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      select('clip', p.id);
      scrub(e, track); // clicking a piece also moves the playhead there
    });
    bar.addEventListener('keydown', (e) => onPieceKey(e, p));
    track.appendChild(bar);
  });
  return r;
}

function lane(labelText, item) {
  const { r, track } = row(labelText);
  const bar = makeBar('text', item, item.kind === 'emoji' ? 'emoji' : '');
  bar.insertAdjacentHTML('beforeend', '<div class="tl-edge l"></div><div class="tl-edge r"></div>');
  bar.dataset.hint = 'When this shows. Drag to move it, drag an edge to trim; edges snap to splits and the playhead. Arrows move it, [ and ] set its ends to the playhead.';
  bar.addEventListener('pointerdown', (e) => dragBar(e, item, bar));
  bar.addEventListener('keydown', (e) => onBarKey(e, item));
  track.appendChild(bar);
  return r;
}

function makeBar(type, item, extra) {
  const bar = document.createElement('div');
  bar.className = `tl-bar ${type} ${extra}`;
  bar.innerHTML = '<span class="tl-name"></span>';
  const key = `${type}:${item.id}`;
  bar.tabIndex = 0;
  bar.dataset.tlKey = key;
  bar.setAttribute('role', 'button');
  bar.addEventListener('focus', () => select(type, item.id));
  bars.set(key, bar);
  return bar;
}

function select(type, id) {
  if (state.selected?.type !== type || state.selected.id !== id) {
    state.selected = { type, id };
    emit();
  }
}

function layoutBars() {
  const pps = pxPerSec();
  const sel = state.selected ? `${state.selected.type}:${state.selected.id}` : '';
  const list = pieces();
  for (const [key, bar] of bars) {
    const [type, id] = key.split(':');
    const item = (type === 'text' ? state.texts : state.clips).find((i) => i.id === Number(id));
    if (!item) continue;
    const s = srcToOut(item.start);
    const e = srcToOut(item.end);
    const cut = e - s < 0.02; // a text sitting entirely in a deleted piece
    bar.style.left = `${s * pps}px`;
    bar.style.width = `${Math.max(cut ? 6 : 2, (e - s) * pps)}px`;
    bar.classList.toggle('cut', cut);
    bar.classList.toggle('selected', key === sel);
    let name;
    let label;
    if (type === 'clip') {
      const n = list.indexOf(item) + 1;
      name = item.rate === 1 ? '' : `${item.rate}x`;
      label = `Clip piece ${n} of ${list.length}, ${s.toFixed(2)} to ${e.toFixed(2)} seconds, ${item.rate}x speed`;
    } else {
      const isEmoji = item.kind === 'emoji';
      name = isEmoji ? item.label : item.text;
      label = `${isEmoji ? 'Emoji' : 'Text'} ${name}, ` +
        (cut ? 'hidden: it sits in a deleted piece' : `${s.toFixed(2)} to ${e.toFixed(2)} seconds`);
    }
    bar.querySelector('.tl-name').textContent = name;
    bar.setAttribute('aria-label', label);
  }
}

// ---- playhead ----
// Scrubbing lands exactly on a frame, so the flag and the picture always agree.
const onFrame = (o) => Math.round(o / FRAME) * FRAME;

function seekOut(o) {
  video.currentTime = clamp(outToSrc(clamp(o, 0, outDuration()), true), 0, state.duration);
}

function scrub(e, trackEl) {
  if (e.target.closest('.tl-bar.text')) return;
  const track = trackEl || e.currentTarget;
  const seek = (ev) => {
    const r = track.getBoundingClientRect();
    seekOut(onFrame((ev.clientX - r.left) / pxPerSec()));
    keepPlayheadInView(); // dragging past the edge scrolls the timeline along
  };
  seek(e);
  track.setPointerCapture(e.pointerId);
  const up = () => {
    track.removeEventListener('pointermove', seek);
    track.removeEventListener('pointerup', up);
  };
  track.addEventListener('pointermove', seek);
  track.addEventListener('pointerup', up);
}

// ---- text / emoji bars (all in output time) ----
const outRange = (item) => ({ s: srcToOut(item.start), e: srcToOut(item.end) });
function setOutRange(item, s, e) {
  item.start = outToSrc(s, true);
  item.end = outToSrc(e);
}

// Nearest snap point within SNAP_PX of output time o, or null.
function snapTarget(o) {
  const pps = pxPerSec();
  const targets = [...pieceEdgesOut(), outNow()];
  let best = null;
  for (const t of targets) {
    if (Math.abs(t - o) * pps <= SNAP_PX && (best === null || Math.abs(t - o) < Math.abs(best - o))) best = t;
  }
  return best;
}

function showSnap(o) {
  if (o === null) {
    snapLine.hidden = true;
    return;
  }
  snapLine.hidden = false;
  snapLine.style.left = `${o * pxPerSec()}px`;
}

function dragBar(e, item, bar) {
  e.preventDefault();
  e.stopPropagation();
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  select('text', item.id);

  const px = e.clientX;
  const { s: s0, e: e0 } = outRange(item);
  const total = outDuration();
  bar.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dt = (ev.clientX - px) / pxPerSec();
    let s = s0;
    let en = e0;
    let snapped = null;
    if (mode === 'move') {
      const len = e0 - s0;
      s = clamp(s0 + dt, 0, total - len);
      const a = snapTarget(s);
      const b = snapTarget(s + len);
      if (a !== null && (b === null || Math.abs(a - s) <= Math.abs(b - s - len))) { s = a; snapped = a; }
      else if (b !== null) { s = b - len; snapped = b; }
      s = clamp(s, 0, total - len);
      en = s + len;
    } else if (mode === 'l') {
      s = clamp(s0 + dt, 0, e0 - MIN_LEN);
      const a = snapTarget(s);
      if (a !== null && a < e0 - MIN_LEN) { s = a; snapped = a; }
    } else {
      en = clamp(e0 + dt, s0 + MIN_LEN, total);
      const b = snapTarget(en);
      if (b !== null && b > s0 + MIN_LEN) { en = b; snapped = b; }
    }
    showSnap(snapped);
    setOutRange(item, s, en);
    emit();
  };
  const up = () => {
    showSnap(null);
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
}

// ---- keyboard ----

// Playhead slider (output time): arrows 0.1s (Shift 1s), , and . one frame, Home/End.
function onRulerKey(e) {
  const o = outNow();
  const big = e.shiftKey ? 1 : 0.1;
  const keys = {
    ArrowLeft: o - big, ArrowDown: o - big, ArrowRight: o + big, ArrowUp: o + big,
    ',': o - FRAME, '.': o + FRAME, Home: 0, End: outDuration(),
  };
  if (!(e.key in keys)) return;
  e.preventDefault();
  seekOut(keys[e.key]);
}

// Text/emoji bars: arrows move (Shift = 1s), Ctrl+arrows stretch or shrink the end,
// [ and ] set the start or end to the playhead, Enter jumps the playhead to the start.
function onBarKey(e, item) {
  const total = outDuration();
  const { s, e: en } = outRange(item);
  const step = e.shiftKey ? 1 : 0.1;
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  const o = outNow();

  if (dir && (e.ctrlKey || e.metaKey)) {
    setOutRange(item, s, clamp(en + dir * step, s + MIN_LEN, total));
  } else if (dir) {
    const len = en - s;
    const ns = clamp(s + dir * step, 0, total - len);
    setOutRange(item, ns, ns + len);
  } else if (e.key === '[') {
    setOutRange(item, clamp(o, 0, en - MIN_LEN), en);
  } else if (e.key === ']') {
    setOutRange(item, s, clamp(o, s + MIN_LEN, total));
  } else if (e.key === 'Enter') {
    seekOut(s);
    return;
  } else {
    return;
  }
  e.preventDefault();
  emit();
}

// Clip pieces: Enter jumps the playhead to the piece, arrows move to the next piece.
// Delete (handled in main.js) removes the selected piece.
function onPieceKey(e, p) {
  const list = pieces();
  const i = list.indexOf(p);
  if (e.key === 'Enter') {
    seekOut(srcToOut(p.start));
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const next = list[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) bars.get(`clip:${next.id}`)?.focus();
  } else {
    return;
  }
  e.preventDefault();
}

