// 9:16 preview canvas: draws both crops stacked, then text and emoji.
// They can be dragged to move them, or resized from the corner handle. Items are
// pinned to the footage (see placeIn in state.js), so moves made here are turned
// back into a point in the source through the crop box under the pointer.

import {
  state, emit, OUT_W, OUT_H, slotH, clamp, placeIn, fromVertical, vertScale,
  selectedTexts, isSelected, selectOnly, toggleSelect, makeMain, snapshotItems, moveItems, scaleItems,
} from './state.js';
import { FONT, drawComposite, drawText, textVisual } from './render.js';
import { showStatus, OVERLAP_MSG } from './status.js';

const HANDLE = 44; // handle size in canvas px

let canvas, ctx, video;

export function initPreview(c, v) {
  canvas = c;
  video = v;
  ctx = canvas.getContext('2d');
  canvas.addEventListener('pointerdown', onPointerDown);
  video.addEventListener('emptied', () => { haveHeld = false; }); // a new clip: don't show the old one's frame
  canvas.addEventListener('keydown', onKey);
}

// Keyboard: with text or emoji selected, arrows move the selection and +/- scale
// it (a group grows as one). Shift = bigger steps.
function onKey(e) {
  const items = selectedTexts();
  const tx = items[0];
  if (!tx) return;
  const sc = vertScale(tx); // steps are in preview pixels, stored in source pixels
  const step = (e.shiftKey ? 50 : 10) / sc;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  const snap = snapshotItems(items);
  if (moves[e.key]) {
    moveItems(snap, moves[e.key][0], moves[e.key][1]);
  } else if (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') {
    const grow = e.key === '+' || e.key === '=' ? 1 : -1;
    scaleItems(snap, { x: tx.x, y: tx.y }, (tx.size + (grow * 8) / sc) / tx.size);
  } else {
    return;
  }
  e.preventDefault();
  emit();
}

// The last good frame. While the video is seeking (scrubbing, dragging the flag)
// it has no frame for a moment; drawing from this copy instead of painting black
// stops the vertical preview flashing.
const held = document.createElement('canvas');
const heldCtx = held.getContext('2d');
let haveHeld = false;

function holdFrame() {
  if (held.width !== video.videoWidth || held.height !== video.videoHeight) {
    held.width = video.videoWidth;
    held.height = video.videoHeight;
  }
  heldCtx.drawImage(video, 0, 0);
  haveHeld = true;
}

const drawFromVideo = (c, ...args) => c.drawImage(video, ...args);
const drawFromHeld = (c, ...args) => c.drawImage(held, ...args);

export function drawPreview() {
  const t = video.currentTime;
  const ready = video.readyState >= 2 && !video.seeking && video.videoWidth > 0;
  if (ready) holdFrame();
  drawComposite(ctx, ready ? drawFromVideo : haveHeld ? drawFromHeld : null, t);

  // editor-only overlays: ghosts of selected items that aren't showing right now,
  // a thin outline on each selected item, the group's box, and the main one's handle
  const items = selectedTexts();
  for (const it of items) if (!textVisual(it, t)) drawText(ctx, it, 1, 0.35);
  for (const it of items.slice(1)) drawOutline(textBox(it), 2, [8, 6]);
  if (items.length > 1) drawOutline(unionBox(items.map(textBox)), 2, [3, 6]);
  if (items[0]) drawSelection(items[0]);
  drawGuides();
}

// ---- snap guides for text: frame centre line + centre of each section ----
const SNAP = 24; // canvas px
const activeGuides = { x: null, y: null };

function snapTargetsY() {
  const topH = slotH('A');
  return [topH / 2, topH + (OUT_H - topH) / 2];
}

// Snaps a point in the preview (not the item) to the guides, before it's
// turned back into a footage point.
function snapPoint(v) {
  activeGuides.x = null;
  activeGuides.y = null;
  if (Math.abs(v.x - OUT_W / 2) < SNAP) {
    v.x = OUT_W / 2;
    activeGuides.x = OUT_W / 2;
  }
  for (const y of snapTargetsY()) {
    if (Math.abs(v.y - y) < SNAP) {
      v.y = y;
      activeGuides.y = y;
    }
  }
  return v;
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
  const { x, y, s } = placeIn(tx, 'v');
  if (tx.kind === 'emoji') {
    const e = s * 1.06;
    return { x: x - e / 2, y: y - e / 2, w: e, h: e };
  }
  ctx.font = `${s}px ${FONT}`;
  const w = ctx.measureText(tx.text).width + s * 0.3;
  const h = s * 1.1;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

function drawOutline(r, width, dash) {
  ctx.save();
  ctx.strokeStyle = '#7c5cff';
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const bt = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x - 8, y: y - 8, w: r - x + 16, h: bt - y + 16 };
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
  const additive = e.ctrlKey || e.metaKey || e.shiftKey; // Ctrl/Shift + click adds to the selection
  const selId = state.selected?.type === 'text' ? state.selected.id : null;
  const selTx = state.texts.find((i) => i.id === selId);

  let mode = null;
  let tx = null;

  if (selTx && !additive) {
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
      (isSelected(i.id) || (t >= i.start && t <= i.end)) && inside(p, textBox(i)));
    tx = hits[hits.length - 1] || null;
    if (tx) mode = 'move';
    if (hits.length > 1) showStatus(OVERLAP_MSG, 20000);
  }

  if (!tx) {
    if (!additive) selectOnly(null);
    emit();
    return;
  }
  if (additive) {
    toggleSelect(tx.id);
    emit();
    return;
  }
  // clicking something already selected keeps the selection, so the group moves together
  if (isSelected(tx.id)) makeMain(tx.id);
  else selectOnly('text', tx.id);
  emit();

  const v0 = placeIn(tx, 'v');
  const start = { x: tx.x, y: tx.y, size: tx.size, dist: Math.hypot(p.x - v0.x, p.y - v0.y) || 1 };
  const snap = snapshotItems(selectedTexts());
  canvas.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const q = toCanvas(ev);
    if (mode === 'move') {
      // the grabbed item follows the pointer (and the guides); the rest move with it
      const v = snapPoint({ x: clamp(v0.x + q.x - p.x, 0, OUT_W), y: clamp(v0.y + q.y - p.y, 0, OUT_H) });
      const src = fromVertical(v.x, v.y);
      moveItems(snap, src.x - start.x, src.y - start.y);
    } else {
      const d = Math.hypot(q.x - v0.x, q.y - v0.y);
      scaleItems(snap, { x: start.x, y: start.y }, d / start.dist);
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
