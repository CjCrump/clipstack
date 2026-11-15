// Timeline: a ruler, one speed lane, and one lane per text layer.
// Drag a bar to move it, drag its edges to stretch or shrink it.
// Click or drag on the ruler / empty track to scrub.
// Keyboard: the ruler is a playhead slider; bars are focusable (see onBarKey).

import { state, emit, subscribe, clamp } from './state.js';

const MIN_LEN = 0.1;

const FRAME = 1 / 30;

let root, video, playhead, ruler;
let lastAriaT = -1;
let structureKey = '';
const bars = new Map(); // "type:id" -> element

export function initTimeline(el, v) {
  root = el;
  video = v;
  subscribe(render);
  new ResizeObserver(() => { structureKey = ''; render(); }).observe(root);
}

const pxPerSec = () => {
  const track = root.querySelector('.tl-track');
  return track && state.duration ? track.clientWidth / state.duration : 1;
};

export function updatePlayhead(t) {
  if (playhead) playhead.style.left = `${t * pxPerSec()}px`;
  if (ruler && Math.abs(t - lastAriaT) > 0.05) {
    lastAriaT = t;
    ruler.setAttribute('aria-valuenow', t.toFixed(2));
    ruler.setAttribute('aria-valuetext', `${t.toFixed(1)} seconds`);
  }
}

function render() {
  const key = `${state.duration}|${state.speeds.map((s) => s.id)}|${state.texts.map((t) => t.id)}`;
  if (key !== structureKey) {
    structureKey = key;
    build();
  }
  layoutBars();
}

function build() {
  // rebuilding replaces the elements, so put keyboard focus back where it was
  const focusedKey = root.contains(document.activeElement) ? document.activeElement.dataset.tlKey : null;
  root.innerHTML = '';
  bars.clear();
  ruler = null;
  if (!state.duration) return;

  root.appendChild(rulerRow());
  root.appendChild(lane('Speed', state.speeds, 'speed'));
  const counts = { text: 0, emoji: 0 };
  state.texts.forEach((t) => {
    const kind = t.kind === 'emoji' ? 'emoji' : 'text';
    counts[kind]++;
    root.appendChild(lane(`${kind === 'emoji' ? 'Emoji' : 'Text'} ${counts[kind]}`, [t], 'text'));
  });

  const layer = document.createElement('div');
  layer.className = 'tl-playhead-layer';
  playhead = document.createElement('div');
  playhead.className = 'tl-playhead';
  layer.appendChild(playhead);
  root.appendChild(layer);

  const refocus = focusedKey === 'ruler' ? ruler : bars.get(focusedKey);
  refocus?.focus();
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
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', state.duration.toFixed(2));
  track.addEventListener('keydown', onRulerKey);
  lastAriaT = -1;
  const step = state.duration > 60 ? 5 : 1;
  for (let s = 0; s <= state.duration; s += step) {
    const tick = document.createElement('div');
    tick.className = 'tl-tick';
    tick.style.left = `${(s / state.duration) * 100}%`;
    tick.textContent = `${s}s`;
    track.appendChild(tick);
  }
  return r;
}

function lane(labelText, items, type) {
  const { r, track } = row(labelText);
  for (const item of items) {
    const bar = document.createElement('div');
    bar.className = `tl-bar ${type}`;
    bar.innerHTML = '<span class="tl-name"></span><div class="tl-edge l"></div><div class="tl-edge r"></div>';
    const key = `${type}:${item.id}`;
    bar.tabIndex = 0;
    bar.dataset.tlKey = key;
    bar.setAttribute('role', 'button');
    bar.addEventListener('pointerdown', (e) => dragBar(e, type, item, bar));
    bar.addEventListener('focus', () => {
      if (state.selected?.type !== type || state.selected.id !== item.id) {
        state.selected = { type, id: item.id };
        emit();
      }
    });
    bar.addEventListener('keydown', (e) => onBarKey(e, type, item));
    track.appendChild(bar);
    bars.set(key, bar);
  }
  return r;
}

function layoutBars() {
  const pps = pxPerSec();
  const sel = state.selected ? `${state.selected.type}:${state.selected.id}` : '';
  for (const [key, bar] of bars) {
    const [type, id] = key.split(':');
    const list = type === 'text' ? state.texts : state.speeds;
    const item = list.find((i) => i.id === Number(id));
    if (!item) continue;
    bar.style.left = `${item.start * pps}px`;
    bar.style.width = `${(item.end - item.start) * pps}px`;
    const isEmoji = item.kind === 'emoji';
    const name = type === 'text' ? (isEmoji ? item.label : item.text) : `${item.rate}x`;
    bar.querySelector('.tl-name').textContent = name;
    bar.setAttribute('aria-label',
      `${type === 'text' ? (isEmoji ? 'Emoji' : 'Text') : 'Speed'} ${name}, ${item.start.toFixed(2)} to ${item.end.toFixed(2)} seconds`);
    bar.classList.toggle('selected', key === sel);
  }
}

function scrub(e) {
  if (e.target.closest('.tl-bar')) return;
  const track = e.currentTarget;
  const seek = (ev) => {
    const r = track.getBoundingClientRect();
    video.currentTime = clamp((ev.clientX - r.left) / pxPerSec(), 0, state.duration);
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

// Speed segments can't overlap, so find the free space around one.
function speedBounds(item) {
  let lo = 0;
  let hi = state.duration;
  for (const s of state.speeds) {
    if (s === item) continue;
    if (s.end <= item.start) lo = Math.max(lo, s.end);
    if (s.start >= item.end) hi = Math.min(hi, s.start);
  }
  return { lo, hi };
}

function dragBar(e, type, item, bar) {
  e.preventDefault();
  e.stopPropagation();
  const mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'move';
  state.selected = { type, id: item.id };
  emit();

  const px = e.clientX;
  const s0 = item.start;
  const e0 = item.end;
  const { lo, hi } = type === 'speed' ? speedBounds(item) : { lo: 0, hi: state.duration };
  bar.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dt = (ev.clientX - px) / pxPerSec();
    if (mode === 'move') {
      const len = e0 - s0;
      item.start = clamp(s0 + dt, lo, hi - len);
      item.end = item.start + len;
    } else if (mode === 'l') {
      item.start = clamp(s0 + dt, lo, e0 - MIN_LEN);
    } else {
      item.end = clamp(e0 + dt, s0 + MIN_LEN, hi);
    }
    emit();
  };
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
}

// ---- keyboard ----

function seekTo(t) {
  video.currentTime = clamp(t, 0, state.duration);
}

// Playhead slider: arrows step 0.1s (Shift 1s), , and . step one frame, Home/End.
function onRulerKey(e) {
  const t = video.currentTime;
  const big = e.shiftKey ? 1 : 0.1;
  const keys = {
    ArrowLeft: t - big, ArrowDown: t - big, ArrowRight: t + big, ArrowUp: t + big,
    ',': t - FRAME, '.': t + FRAME, Home: 0, End: state.duration,
  };
  if (!(e.key in keys)) return;
  e.preventDefault();
  seekTo(keys[e.key]);
}

// Bars: arrows move (Shift = 1s steps), Ctrl+arrows stretch or shrink the end,
// [ and ] set the start or end to the playhead, Enter jumps the playhead to the start.
function onBarKey(e, type, item) {
  const { lo, hi } = type === 'speed' ? speedBounds(item) : { lo: 0, hi: state.duration };
  const step = e.shiftKey ? 1 : 0.1;
  const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  const t = video.currentTime;

  if (dir && (e.ctrlKey || e.metaKey)) {
    item.end = clamp(item.end + dir * step, item.start + MIN_LEN, hi);
  } else if (dir) {
    const len = item.end - item.start;
    item.start = clamp(item.start + dir * step, lo, hi - len);
    item.end = item.start + len;
  } else if (e.key === '[') {
    item.start = clamp(t, lo, item.end - MIN_LEN);
  } else if (e.key === ']') {
    item.end = clamp(t, item.start + MIN_LEN, hi);
  } else if (e.key === 'Enter') {
    seekTo(item.start);
  } else {
    return;
  }
  e.preventDefault();
  emit();
}
