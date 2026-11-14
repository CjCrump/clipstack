// Two linked crop boxes drawn over the source video.
// Corners scale a box (split stays the same). Top/bottom edges change the
// split, and the other box re-sizes to match its new output slot.

import { state, emit, subscribe, OUT_W, OUT_H, box, boxH, clampBoxes, clamp } from './state.js';

let stage, overlay, wrap, readout;
let scale = 1; // display px per source px
const els = {};

export function initCropBoxes(opts) {
  ({ stage, overlay, wrap, readout } = opts);
  els.A = makeBox('A', 'Top');
  els.B = makeBox('B', 'Bottom');
  subscribe(render);
  new ResizeObserver(layout).observe(wrap);
}

export function layout() {
  if (!state.duration) return;
  const maxW = wrap.clientWidth - 24;
  const maxH = wrap.clientHeight - 24;
  let w = maxW;
  let h = (w * state.srcH) / state.srcW;
  if (h > maxH) {
    h = maxH;
    w = (h * state.srcW) / state.srcH;
  }
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  scale = w / state.srcW;
  render();
}

function makeBox(k, label) {
  const el = document.createElement('div');
  el.className = `cropbox ${k.toLowerCase()}`;
  el.innerHTML = `<span class="tag">${label}</span>` +
    ['nw', 'ne', 'sw', 'se', 'n', 's'].map((h) => `<div class="handle" data-h="${h}"></div>`).join('');
  el.addEventListener('pointerdown', (e) => startDrag(e, k));
  overlay.appendChild(el);
  return el;
}

function startDrag(e, k) {
  e.preventDefault();
  const el = els[k];
  const handle = e.target.dataset.h || 'move';
  const other = k === 'A' ? 'B' : 'A';
  const b = box(k);
  const start = {
    px: e.clientX,
    py: e.clientY,
    x: b.x,
    y: b.y,
    w: b.w,
    h: boxH(k),
    otherCenterY: box(other).y + boxH(other) / 2,
  };
  el.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - start.px) / scale;
    const dy = (ev.clientY - start.py) / scale;
    applyDrag(k, other, handle, start, dx, dy);
    clampBoxes();
    emit();
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function applyDrag(k, other, handle, s, dx, dy) {
  const b = box(k);

  if (handle === 'move') {
    b.x = s.x + dx;
    b.y = s.y + dy;
    return;
  }

  if (handle.length === 2) {
    // corner: uniform scale, opposite corner stays put
    const w = Math.max(80, handle.includes('e') ? s.w + dx : s.w - dx);
    const h = (w * s.h) / s.w;
    b.w = w;
    b.x = handle.includes('w') ? s.x + s.w - w : s.x;
    b.y = handle.includes('n') ? s.y + s.h - h : s.y;
    return;
  }

  // top/bottom edge: height changes, which changes the split
  const newH = Math.max(40, handle === 's' ? s.h + dy : s.h - dy);
  const slot = (newH * OUT_W) / b.w; // output px this box now needs
  const split = k === 'A' ? slot / OUT_H : 1 - slot / OUT_H;
  state.split = clamp(split, 0.15, 0.85);
  if (handle === 'n') b.y = s.y + s.h - boxH(k);

  // other box keeps its width and centre, height follows the new slot
  box(other).y = s.otherCenterY - boxH(other) / 2;
}

function render() {
  for (const k of ['A', 'B']) {
    const b = box(k);
    const s = els[k].style;
    s.left = `${b.x * scale}px`;
    s.top = `${b.y * scale}px`;
    s.width = `${b.w * scale}px`;
    s.height = `${boxH(k) * scale}px`;
  }
  const top = Math.round(state.split * 100);
  readout.textContent = `top ${top}% / bottom ${100 - top}%`;
}
