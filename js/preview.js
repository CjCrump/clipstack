// 9:16 preview canvas: draws both crops stacked, then text layers.
// Text can be dragged to move it, or resized from its corner handle.

import { state, emit, OUT_W, OUT_H, slotH, clamp } from './state.js';
import { FONT, drawComposite, drawText, textVisual } from './render.js';

const HANDLE = 44; // handle size in canvas px

let canvas, ctx, video;

export function initPreview(c, v) {
  canvas = c;
  video = v;
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('keydown', onKey);
}

// Keyboard: with a text or emoji selected, arrows move it and +/- resize it (Shift = bigger steps).
function onKey(e) {
  const tx = state.selected?.type === 'text' && state.texts.find((i) => i.id === state.selected.id);
  if (!tx) return;
  const step = e.shiftKey ? 50 : 10;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (moves[e.key]) {
    tx.x = clamp(tx.x + moves[e.key][0], 0, OUT_W);
    tx.y = clamp(tx.y + moves[e.key][1], 0, OUT_H);
  } else if (e.key === '+' || e.key === '=') {
    tx.size = clamp(tx.size + 8, 30, 400);
  } else if (e.key === '-' || e.key === '_') {
    tx.size = clamp(tx.size - 8, 30, 400);
  } else {
    return;
  }
  e.preventDefault();
  emit();
}

const drawFromVideo = (c, ...args) => c.drawImage(video, ...args);

export function drawPreview() {
  const t = video.currentTime;
  drawComposite(ctx, video.readyState >= 2 ? drawFromVideo : null, t);

  // editor-only overlays
  const sel = state.selected?.type === 'text' ? state.selected.id : null;
  const tx = sel && state.texts.find((i) => i.id === sel);
  if (tx) {
    if (!textVisual(tx, t)) drawText(ctx, tx, 1, 0.35); // ghost so it can be placed
    drawSelection(tx);
  }
  drawGuides();
}

// ---- snap guides for text: frame centre line + centre of each section ----
const SNAP = 24; // canvas px
const activeGuides = { x: null, y: null };

function snapTargetsY() {
  const topH = slotH('A');
  return [topH / 2, topH + (OUT_H - topH) / 2];
}

function snapText(tx) {
  activeGuides.x = null;
  activeGuides.y = null;
  if (Math.abs(tx.x - OUT_W / 2) < SNAP) {
    tx.x = OUT_W / 2;
    activeGuides.x = OUT_W / 2;
  }
  for (const y of snapTargetsY()) {
    if (Math.abs(tx.y - y) < SNAP) {
      tx.y = y;
      activeGuides.y = y;
    }
  }
}

function drawGuides() {
  if (activeGuides.x === null && activeGuides.y === null) return;
  ctx.save();
  ctx.fillStyle = '#ff3ec8';
  if (activeGuides.x !== null) ctx.fillRect(activeGuides.x - 2, 0, 4, OUT_H);
  if (activeGuides.y !== null) ctx.fillRect(0, activeGuides.y - 2, OUT_W, 4);
  ctx.restore();
}

function textBox(tx) {
  if (tx.kind === 'emoji') {
    const s = tx.size * 1.06;
    return { x: tx.x - s / 2, y: tx.y - s / 2, w: s, h: s };
  }
  ctx.font = `${tx.size}px ${FONT}`;
  const w = ctx.measureText(tx.text).width + tx.size * 0.3;
  const h = tx.size * 1.1;
  return { x: tx.x - w / 2, y: tx.y - h / 2, w, h };
}

function drawSelection(tx) {
  const r = textBox(tx);
  ctx.save();
  ctx.strokeStyle = '#7c5cff';
  ctx.lineWidth = 4;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  ctx.fillStyle = '#7c5cff';
  ctx.fillRect(r.x + r.w - HANDLE / 2, r.y + r.h - HANDLE / 2, HANDLE, HANDLE);
  ctx.restore();
}

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * OUT_W) / r.width,
    y: ((e.clientY - r.top) * OUT_H) / r.height,
  };
}

const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function onPointerDown(e) {
  if (state.exporting) return;
  const p = toCanvas(e);
  const t = video.currentTime;
  const selId = state.selected?.type === 'text' ? state.selected.id : null;
  const selTx = state.texts.find((i) => i.id === selId);

  let mode = null;
  let tx = null;

  if (selTx) {
    const r = textBox(selTx);
    const corner = { x: r.x + r.w - HANDLE, y: r.y + r.h - HANDLE, w: HANDLE * 2, h: HANDLE * 2 };
    if (inside(p, corner)) {
      mode = 'resize';
      tx = selTx;
    }
  }

  if (!tx) {
    // topmost visible text under the pointer (the selected ghost counts too)
    const hits = state.texts.filter((i) =>
      (i.id === selId || (t >= i.start && t <= i.end)) && inside(p, textBox(i)));
    tx = hits[hits.length - 1] || null;
    if (tx) mode = 'move';
  }

  if (!tx) {
    state.selected = null;
    emit();
    return;
  }

  state.selected = { type: 'text', id: tx.id };
  emit();

  const start = { x: tx.x, y: tx.y, size: tx.size, dist: Math.hypot(p.x - tx.x, p.y - tx.y) || 1 };
  canvas.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const q = toCanvas(ev);
    if (mode === 'move') {
      tx.x = clamp(start.x + q.x - p.x, 0, OUT_W);
      tx.y = clamp(start.y + q.y - p.y, 0, OUT_H);
      snapText(tx);
    } else {
      const d = Math.hypot(q.x - tx.x, q.y - tx.y);
      tx.size = Math.round(clamp((start.size * d) / start.dist, 30, 400));
    }
    emit();
  };
  const up = () => {
    activeGuides.x = null;
    activeGuides.y = null;
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
}
