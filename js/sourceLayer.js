// The left pane doubles as the horizontal preview: text and emoji are drawn on top
// of the source video where they'll land in the 1920x1080 export. They can be
// dragged and resized here too. It's the same item as in the vertical preview, so
// the other pane follows (see placeIn in state.js).
//
// The Top/Bottom crop boxes sit above this layer. A press that lands on a text or
// emoji is handled here first, so it moves the text instead of the box under it.
// "Hide boxes" clears them away to see the clean horizontal frame.

import { state, emit, clamp, OUT_W, OUT_H, HOR_W, HOR_H, placeIn } from './state.js';
import { FONT, drawText, textVisual, fitRect } from './render.js';
import { showStatus, OVERLAP_MSG } from './status.js';

const SNAP_SCREEN = 8; // px
const HANDLE_SCREEN = 12; // px

let stage, canvas, ctx, video, toggle;
let k = 1; // canvas px per horizontal-frame px
let frame = { x: 0, y: 0, w: HOR_W, h: HOR_H }; // where the source sits in the 1920x1080 frame
const guides = { x: null, y: null };

export function initSourceLayer(opts) {
  ({ stage, canvas, video, toggle } = opts);
  ctx = canvas.getContext('2d');
  new ResizeObserver(size).observe(stage);
  stage.addEventListener('pointerdown', onPointerDown, true); // capture: before the crop boxes
  toggle.addEventListener('click', () => {
    const hide = !stage.classList.contains('boxes-hidden');
    stage.classList.toggle('boxes-hidden', hide);
    toggle.textContent = hide ? 'Show boxes' : 'Hide boxes';
    toggle.setAttribute('aria-pressed', String(hide));
  });
}

function size() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}

// Horizontal-frame coordinates <-> this canvas
function setTransform() {
  frame = fitRect(state.srcW, state.srcH, HOR_W, HOR_H);
  k = canvas.width / frame.w;
  ctx.setTransform(k, 0, 0, k, -frame.x * k, -frame.y * k);
}
function toFrame(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: frame.x + ((e.clientX - r.left) / r.width) * frame.w,
    y: frame.y + ((e.clientY - r.top) / r.height) * frame.h,
  };
}
const screenToFrame = (px) => (px * (window.devicePixelRatio || 1)) / k;

// Box around a text or emoji in horizontal-frame pixels
function itemBox(tx) {
  const { x, y } = placeIn(tx, 'h');
  if (tx.kind === 'emoji') {
    const s = tx.size * 1.06;
    return { x: x - s / 2, y: y - s / 2, w: s, h: s };
  }
  ctx.save();
  ctx.font = `${tx.size}px ${FONT}`;
  const w = ctx.measureText(tx.text).width + tx.size * 0.3;
  ctx.restore();
  const h = tx.size * 1.1;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

export function drawSourceLayer(t) {
  if (!state.duration) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setTransform();
  for (const tx of state.texts) {
    const v = textVisual(tx, t);
    if (v) drawText(ctx, tx, v.scale, v.alpha, 'h');
  }
  const sel = selectedItem();
  if (sel) {
    if (!textVisual(sel, t)) drawText(ctx, sel, 1, 0.35, 'h'); // ghost so it can be placed
    const r = itemBox(sel);
    const lw = screenToFrame(2);
    const hs = screenToFrame(HANDLE_SCREEN);
    ctx.save();
    ctx.strokeStyle = '#7c5cff';
    ctx.lineWidth = lw;
    ctx.setLineDash([screenToFrame(7), screenToFrame(5)]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#7c5cff';
    ctx.fillRect(r.x + r.w - hs / 2, r.y + r.h - hs / 2, hs, hs);
    ctx.restore();
  }
  if (guides.x !== null || guides.y !== null) {
    const g = screenToFrame(2);
    ctx.fillStyle = '#ff3ec8';
    if (guides.x !== null) ctx.fillRect(guides.x - g / 2, frame.y, g, frame.h);
    if (guides.y !== null) ctx.fillRect(frame.x, guides.y - g / 2, frame.w, g);
  }
}

const selectedItem = () => (state.selected?.type === 'text' ? state.texts.find((i) => i.id === state.selected.id) : null);
const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function onPointerDown(e) {
  if (state.exporting || !state.duration) return;
  const p = toFrame(e);
  const t = video.currentTime;
  const sel = selectedItem();
  let mode = null;
  let tx = null;

  if (sel) {
    const r = itemBox(sel);
    const hs = screenToFrame(HANDLE_SCREEN);
    if (inside(p, { x: r.x + r.w - hs, y: r.y + r.h - hs, w: hs * 2, h: hs * 2 })) {
      mode = 'resize';
      tx = sel;
    }
  }
  if (!tx) {
    const hits = state.texts.filter((i) => (i === sel || textVisual(i, t)) && inside(p, itemBox(i)));
    tx = hits[hits.length - 1] || null;
    if (tx) mode = 'move';
    if (hits.length > 1) showStatus(OVERLAP_MSG, 20000);
  }
  if (!tx) return; // not on a text or emoji: let the crop boxes have it

  e.stopPropagation(); // keep the crop box underneath from moving
  e.preventDefault();
  state.selected = { type: 'text', id: tx.id };
  emit();

  const h0 = placeIn(tx, 'h');
  const start = { x: tx.x, y: tx.y, size: tx.size, dist: Math.hypot(p.x - h0.x, p.y - h0.y) || 1 };
  canvas.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const q = toFrame(ev);
    if (mode === 'move') {
      // move in the horizontal frame, store back in vertical-frame units
      tx.x = clamp(start.x + ((q.x - p.x) * OUT_W) / HOR_W, 0, OUT_W);
      tx.y = clamp(start.y + ((q.y - p.y) * OUT_H) / HOR_H, 0, OUT_H);
      snap(tx);
    } else {
      const c = placeIn(tx, 'h');
      tx.size = Math.round(clamp((start.size * Math.hypot(q.x - c.x, q.y - c.y)) / start.dist, 30, 400));
    }
    emit();
  };
  const up = () => {
    guides.x = null;
    guides.y = null;
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
}

// Snap to the centre lines of the horizontal frame
function snap(tx) {
  const tol = screenToFrame(SNAP_SCREEN);
  const h = placeIn(tx, 'h');
  guides.x = null;
  guides.y = null;
  if (Math.abs(h.x - HOR_W / 2) < tol) {
    tx.x = OUT_W / 2;
    guides.x = HOR_W / 2;
  }
  if (Math.abs(h.y - HOR_H / 2) < tol) {
    tx.y = OUT_H / 2;
    guides.y = HOR_H / 2;
  }
}
