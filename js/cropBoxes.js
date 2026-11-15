// Two linked crop boxes drawn over the source video.
// Any handle reshapes a box freely; its new shape sets the split and the other
// box re-shapes to fill the rest of the 9:16 frame. Shift + corner scales
// without changing the split. Moving a box snaps its centre to the video's centre.

import { state, emit, subscribe, OUT_W, OUT_H, box, boxH, clampBoxes, clamp } from './state.js';

const SNAP_PX = 8; // snap distance in screen pixels

let stage, overlay, wrap, readout;
let scale = 1; // display px per source px
const els = {};
const guides = { x: false, y: false };
const guideEls = {};

export function initCropBoxes(opts) {
  ({ stage, overlay, wrap, readout } = opts);
  els.A = makeBox('A', 'Top');
  els.B = makeBox('B', 'Bottom');
  for (const axis of ['x', 'y']) {
    guideEls[axis] = document.createElement('div');
    guideEls[axis].className = `guide guide-${axis}`;
    overlay.appendChild(guideEls[axis]);
  }
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
    ['nw', 'ne', 'sw', 'se', 'n', 's', 'e', 'w'].map((h) => `<div class="handle" data-h="${h}"></div>`).join('');
  el.tabIndex = 0;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', `${label} crop box`);
  el.setAttribute('aria-describedby', 'boxKeysHelp');
  el.dataset.hintFocus = 'only'; // a hover tip would sit in the way while dragging
  el.dataset.hint = k === 'A'
    ? 'Top of the video, usually gameplay. Drag it, or drag a handle to resize. The other box follows so the frame stays full.'
    : 'Bottom of the video, usually your facecam. Drag it, or drag a handle to resize. The other box follows so the frame stays full.';
  el.addEventListener('pointerdown', (e) => startDrag(e, k));
  el.addEventListener('keydown', (e) => onBoxKey(e, k));
  overlay.appendChild(el);
  return el;
}

// Keyboard: arrows move, Ctrl+arrows reshape (changes the split), +/- scale.
// Shift makes every step bigger. Reuses the mouse code so behaviour matches.
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

function onBoxKey(e, k) {
  const other = k === 'A' ? 'B' : 'A';
  const b = box(k);
  const step = e.shiftKey ? 40 : 4; // source pixels
  let handle;
  let dx = 0;
  let dy = 0;
  let uniform = false;

  if (ARROWS[e.key]) {
    const [ax, ay] = ARROWS[e.key];
    if (e.ctrlKey || e.metaKey) {
      handle = ay ? 's' : 'e';
      dx = ax * step * 2;
      dy = ay * step * 2;
    } else {
      handle = 'move';
      dx = ax * step;
      dy = ay * step;
    }
  } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
    handle = 'se';
    uniform = true;
    dx = (e.key === '-' || e.key === '_' ? -1 : 1) * b.w * 0.02;
  } else {
    return;
  }

  e.preventDefault();
  const start = {
    px: 0, py: 0, x: b.x, y: b.y, w: b.w, h: boxH(k),
    otherCenterY: box(other).y + boxH(other) / 2,
  };
  if (handle === 'move') {
    // no snapping here, or small steps near the centre line would never move
    b.x += dx;
    b.y += dy;
  } else {
    applyDrag(k, other, handle, start, dx, dy, uniform);
  }
  clampBoxes();
  emit();
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
    applyDrag(k, other, handle, start, dx, dy, ev.shiftKey);
    clampBoxes();
    emit();
  };
  const up = () => {
    guides.x = guides.y = false;
    renderGuides();
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function applyDrag(k, other, handle, s, dx, dy, shift) {
  const b = box(k);
  guides.x = guides.y = false;

  if (handle === 'move') {
    b.x = s.x + dx;
    b.y = s.y + dy;
    snapToCenter(k);
    return;
  }

  // Shift + corner: uniform scale, split stays the same
  if (shift && handle.length === 2) {
    const w = Math.max(80, handle.includes('e') ? s.w + dx : s.w - dx);
    const h = (w * s.h) / s.w;
    b.w = w;
    b.x = handle.includes('w') ? s.x + s.w - w : s.x;
    b.y = handle.includes('n') ? s.y + s.h - h : s.y;
    return;
  }

  // Free resize: any handle can change width and/or height.
  // The new shape sets the split, and the other box re-shapes to fill the rest.
  let w = s.w;
  let h = s.h;
  if (handle.includes('e')) w = s.w + dx;
  if (handle.includes('w')) w = s.w - dx;
  if (handle.includes('s')) h = s.h + dy;
  if (handle.includes('n')) h = s.h - dy;
  w = Math.max(80, w);
  h = Math.max(40, h);

  const slot = (h * OUT_W) / w; // output px this box now needs
  const split = k === 'A' ? slot / OUT_H : 1 - slot / OUT_H;
  state.split = clamp(split, 0.15, 0.85);
  b.w = w;

  // keep the edge opposite the handle anchored
  b.x = handle.includes('w') ? s.x + s.w - w : s.x;
  b.y = handle.includes('n') ? s.y + s.h - boxH(k) : s.y;

  // other box keeps its width and centre, height follows the new slot
  box(other).y = s.otherCenterY - boxH(other) / 2;
}

// Snap a moving box's centre to the source video's centre lines.
function snapToCenter(k) {
  const b = box(k);
  const tol = SNAP_PX / scale;
  const cx = b.x + b.w / 2;
  const cy = b.y + boxH(k) / 2;
  if (Math.abs(cx - state.srcW / 2) < tol) {
    b.x = state.srcW / 2 - b.w / 2;
    guides.x = true;
  }
  if (Math.abs(cy - state.srcH / 2) < tol) {
    b.y = state.srcH / 2 - boxH(k) / 2;
    guides.y = true;
  }
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
  renderGuides();
  const top = Math.round(state.split * 100);
  readout.textContent = `top ${top}% / bottom ${100 - top}%`;
}

function renderGuides() {
  guideEls.x.hidden = !guides.x;
  guideEls.y.hidden = !guides.y;
}
