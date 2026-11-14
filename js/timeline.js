// Timeline: a ruler, one speed lane, and one lane per text layer.
// Drag a bar to move it, drag its edges to stretch or shrink it.
// Click or drag on the ruler / empty track to scrub.

import { state, emit, subscribe, clamp } from './state.js';

const MIN_LEN = 0.1;

let root, video, playhead;
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
  root.innerHTML = '';
  bars.clear();
  if (!state.duration) return;

  root.appendChild(rulerRow());
  root.appendChild(lane('Speed', state.speeds, 'speed'));
  state.texts.forEach((t, i) => root.appendChild(lane(`Text ${i + 1}`, [t], 'text')));

  const layer = document.createElement('div');
  layer.className = 'tl-playhead-layer';
  playhead = document.createElement('div');
  playhead.className = 'tl-playhead';
  layer.appendChild(playhead);
  root.appendChild(layer);
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
    bar.addEventListener('pointerdown', (e) => dragBar(e, type, item, bar));
    track.appendChild(bar);
    bars.set(`${type}:${item.id}`, bar);
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
    bar.querySelector('.tl-name').textContent = type === 'text' ? item.text : `${item.rate}x`;
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
