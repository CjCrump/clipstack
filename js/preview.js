// 9:16 preview canvas: draws both crops stacked, then text layers.
// Text can be dragged to move it, or resized from its corner handle.

import {
  state, emit, OUT_W, OUT_H, box, slotH, boxH, srcToOut, popScale, popAlpha, clamp,
} from './state.js';

const FONT = 'Bangers, Impact, sans-serif';
const HANDLE = 44; // handle size in canvas px

let canvas, ctx, video;

export function initPreview(c, v) {
  canvas = c;
  video = v;
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onPointerDown);
}

export function drawPreview() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  if (video.readyState >= 2) {
    const topH = Math.round(slotH('A'));
    const a = box('A');
    const b = box('B');
    ctx.drawImage(video, a.x, a.y, a.w, boxH('A'), 0, 0, OUT_W, topH);
    ctx.drawImage(video, b.x, b.y, b.w, boxH('B'), 0, topH, OUT_W, OUT_H - topH);
  }

  const t = video.currentTime;
  const sel = state.selected?.type === 'text' ? state.selected.id : null;

  for (const tx of state.texts) {
    const v = textVisual(tx, t);
    if (v) drawText(tx, v.scale, v.alpha);
    else if (tx.id === sel && !state.exporting) drawText(tx, 1, 0.35); // ghost so it can be placed
  }

  if (sel && !state.exporting) {
    const tx = state.texts.find((i) => i.id === sel);
    if (tx) drawSelection(tx);
  }

  if (!state.exporting) drawGuides();
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

function textVisual(tx, t) {
  if (t < tx.start || t > tx.end) return null;
  const t0 = srcToOut(tx.start);
  const lt = srcToOut(t) - t0;
  const dur = srcToOut(tx.end) - t0;
  return { scale: tx.anim === 'pop' ? popScale(lt) : 1, alpha: popAlpha(lt, dur) };
}

function drawText(tx, scale, alpha) {
  const size = tx.size * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 8; // matches ffmpeg borderw = size/16 per side
  ctx.strokeStyle = '#000';
  ctx.strokeText(tx.text, tx.x, tx.y);
  ctx.fillStyle = '#fff';
  ctx.fillText(tx.text, tx.x, tx.y);
  ctx.restore();
}

function textBox(tx) {
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
