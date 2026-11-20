// Two linked crop boxes drawn over the source video.
// Any handle reshapes a box freely; its new shape sets the split and the other
// box re-shapes to fill the rest of the 9:16 frame. Shift + corner scales
// without changing the split. Moving a box snaps its centre to the video's centre.
// No facecam mode hides Bottom and turns Top into one 9:16 crop for the whole frame.
// Dragging Bottom right under Top (or Top onto Bottom) snaps them together, and
// letting go switches to No facecam. Hold Alt while dragging to skip the snap.

import { state, emit, subscribe, OUT_W, OUT_H, box, boxH, clampBoxes, clamp, setFacecam } from './state.js';

const SNAP_PX = 8; // snap distance in screen pixels

const HINT_A = 'Top of the video, usually gameplay. Drag it, or drag a handle to resize. The other box follows so the frame stays full. No facecam? Switch to No facecam, or drag Bottom right under Top.';
const HINT_B = 'Bottom of the video, usually your facecam. Drag it, or drag a handle to resize. The other box follows so the frame stays full. No facecam? Switch to No facecam, or drag Bottom right under Top.';
const HINT_SINGLE = 'The whole vertical video comes from this one crop. Drag it, or drag a handle to resize; it stays 9:16.';

let stage, overlay, wrap, readout;
let camBtns = [];
let scale = 1; // display px per source px
const els = {};
const guides = { x: false, y: false };
const guideEls = {};

export function initCropBoxes(opts) {
  ({ stage, overlay, wrap, readout } = opts);
  els.A = makeBox('A', 'Top');
  els.B = makeBox('B', 'Bottom');
  camBtns = [...opts.camSwitch.querySelectorAll('[data-cam]')];
  camBtns.forEach((btn) => btn.addEventListener('click', () => setFacecam(btn.dataset.cam === 'on')));
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
  el.dataset.hint = k === 'A' ? HINT_A : HINT_B;
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
  const before = { ...b }; // where the dragged box goes back to if the drag merges
  let stacked = false;
  state.dragging = true;

  const move = (ev) => {
    const dx = (ev.clientX - start.px) / scale;
    const dy = (ev.clientY - start.py) / scale;
    applyDrag(k, other, handle, start, dx, dy, ev.shiftKey);
    // Bottom dragged right under Top (or Top onto Bottom) snaps there; Alt skips it
    stacked = state.facecam && handle === 'move' && !ev.altKey && snapStack(k);
    clampBoxes();
    setStackGlow(stacked);
    emit();
  };
  const up = () => {
    guides.x = guides.y = false;
    renderGuides();
    setStackGlow(false);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    state.dragging = false;
    if (stacked) mergeStack(k, before); // emits
    else emit(); // lets undo record the drag
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up); // never leave undo paused
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

  // No facecam: one crop locked to 9:16. Edge handles grow it from the middle
  // of that edge, corners from the opposite corner.
  if (!state.facecam) {
    const r = OUT_H / OUT_W;
    let w = s.w;
    if (handle.includes('e')) w = s.w + dx;
    else if (handle.includes('w')) w = s.w - dx;
    else if (handle === 's') w = (s.h + dy) / r;
    else if (handle === 'n') w = (s.h - dy) / r;
    w = Math.max(80, w);
    const h = w * r;
    b.w = w;
    if (handle.includes('w')) b.x = s.x + s.w - w;
    else if (handle === 'n' || handle === 's') b.x = s.x + (s.w - w) / 2;
    else b.x = s.x;
    if (handle.includes('n')) b.y = s.y + s.h - h;
    else if (handle === 'e' || handle === 'w') b.y = s.y + (s.h - h) / 2;
    else b.y = s.y;
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

// If Bottom's top edge is near Top's bottom edge and they overlap side to side,
// pull the dragged box flush against the other and return true.
function snapStack(k) {
  const a = state.boxA;
  const b = state.boxB;
  const tol = (SNAP_PX * 2) / scale;
  const seam = a.y + boxH('A');
  const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  if (overlap <= 0 || Math.abs(b.y - seam) > tol) return false;
  if (k === 'B') b.y = seam;
  else a.y = b.y - boxH('A');
  guides.x = guides.y = false; // the seam glow is the only cue while stacked
  return true;
}

function setStackGlow(on) {
  els.A.classList.toggle('stacked', on);
  els.B.classList.toggle('stacked', on);
}

// Released while stacked: switch to No facecam with one crop where Top is (as
// wide as Top, or as wide as fits). The dragged box goes back to where the drag
// started, so switching back to Facecam doesn't bring it back stuck under Top.
function mergeStack(k, before) {
  const a = state.boxA;
  const r = OUT_H / OUT_W;
  const w = Math.min(a.w, state.srcW, state.srcH / r);
  const crop = { x: a.x + (a.w - w) / 2, y: a.y, w };
  Object.assign(box(k), before);
  setFacecam(false, crop);
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
  const single = !state.facecam;
  els.B.hidden = single;
  els.A.querySelector('.tag').textContent = single ? 'Crop' : 'Top';
  els.A.setAttribute('aria-label', single ? 'Crop box' : 'Top crop box');
  els.A.dataset.hint = single ? HINT_SINGLE : HINT_A;
  camBtns.forEach((btn) => btn.setAttribute('aria-pressed', String((btn.dataset.cam === 'on') === state.facecam)));
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
  readout.textContent = single ? 'off (one crop)' : `top ${top}% / bottom ${100 - top}%`;
}

function renderGuides() {
  guideEls.x.hidden = !guides.x;
  guideEls.y.hidden = !guides.y;
}
