// Shared app state, change notifications, and time/geometry helpers.

export const OUT_W = 1080; // vertical output
export const OUT_H = 1920;
export const HOR_W = 1920; // horizontal output
export const HOR_H = 1080;

// Text and emoji are pinned to the footage: x, y and size are in source-video
// pixels, so whatever they sit on (a head, a health bar) they stay on in both
// videos. Horizontal shows the whole clip, so they land right on that point.
// Vertical shows the clip through the crop boxes, so they go through the box that
// shows that point and scale with its zoom. A point outside both boxes is kept at
// the nearest edge of that box's part of the frame so it never disappears.
export const MIN_SIZE = 20; // source px
export const MAX_SIZE = 600;

// The whole source, scaled to fit a frame (black bars if the shapes differ).
export function fitRect(sw, sh, fw, fh) {
  const k = Math.min(fw / sw, fh / sh);
  return { x: (fw - sw * k) / 2, y: (fh - sh * k) / 2, w: sw * k, h: sh * k };
}

// Which crop box shows source point (x, y): the facecam box first (it's usually
// the smaller one inside the gameplay), then the gameplay box, else the nearest.
export function boxAt(x, y) {
  let best = 'A';
  let bestD = Infinity;
  for (const k of ['B', 'A']) {
    const b = box(k);
    const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
    const dy = Math.max(b.y - y, 0, y - (b.y + boxH(k)));
    const d = Math.hypot(dx, dy);
    if (d === 0) return k;
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

// Where an item lands in a format, and how big: { x, y, s } in that frame's pixels.
export function placeIn(item, fmt) {
  if (fmt === 'h') {
    const r = fitRect(state.srcW, state.srcH, HOR_W, HOR_H);
    const k = r.w / state.srcW;
    return { x: r.x + item.x * k, y: r.y + item.y * k, s: item.size * k };
  }
  const key = boxAt(item.x, item.y);
  const b = box(key);
  const sc = OUT_W / b.w;
  const top = key === 'A' ? 0 : slotH('A');
  const bottom = key === 'A' ? slotH('A') : OUT_H;
  return {
    x: clamp((item.x - b.x) * sc, 0, OUT_W),
    y: clamp(top + (item.y - b.y) * sc, top, bottom),
    s: item.size * sc,
  };
}

// A point in the vertical frame back to the footage, through the box showing that
// part of the frame. sc = vertical px per source px there.
export function fromVertical(vx, vy) {
  const key = vy < slotH('A') ? 'A' : 'B';
  const b = box(key);
  const sc = OUT_W / b.w;
  const top = key === 'A' ? 0 : slotH('A');
  return {
    x: clamp(b.x + vx / sc, 0, state.srcW),
    y: clamp(b.y + (vy - top) / sc, 0, state.srcH),
    sc,
  };
}

// vertical px per source px for an item, where it currently sits
export const vertScale = (item) => OUT_W / box(boxAt(item.x, item.y)).w;

export const state = {
  fileName: 'clip.mp4',
  srcW: 1920,
  srcH: 1080,
  duration: 0,
  split: 0.68, // fraction of the output height used by the top box
  boxA: { x: 542, y: 41, w: 835 }, // top slot (gameplay), source pixels
  boxB: { x: 36, y: 730, w: 562 }, // bottom slot (facecam), source pixels
  // Overlay layers drawn over the video, in stacking order. Text: { id, text, ... }.
  // Emoji: { id, kind: 'emoji', file, label, ... }. Both share x, y (centre), size,
  // start, end and anim, so selecting, dragging and the timeline treat them the same.
  texts: [], // { id, kind?, text | file+label, x, y, size (source px), start, end (source s), anim }
  // The kept pieces of the source clip, in source seconds, in order and never
  // overlapping. Starts as one piece; Split cuts one in two, Delete removes one
  // (that part of the clip is skipped), and each piece has its own speed.
  clips: [], // { id, start, end, rate }
  selected: null, // { type: 'text' | 'clip', id }
  exporting: false,
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
export const emit = () => listeners.forEach((fn) => fn());

let nextId = 1;
export const uid = () => nextId++;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---- crop box geometry ----
export const box = (k) => (k === 'A' ? state.boxA : state.boxB);
export const slotH = (k) => (k === 'A' ? OUT_H * state.split : OUT_H * (1 - state.split));
export const boxH = (k) => (box(k).w * slotH(k)) / OUT_W;

export function clampBoxes() {
  for (const k of ['A', 'B']) {
    const b = box(k);
    const ratio = slotH(k) / OUT_W;
    const maxW = Math.min(state.srcW, state.srcH / ratio);
    b.w = clamp(b.w, 40, maxW);
    b.x = clamp(b.x, 0, state.srcW - b.w);
    b.y = clamp(b.y, 0, state.srcH - b.w * ratio);
  }
}

// ---- selection ----
export function getSelected() {
  const s = state.selected;
  if (!s) return null;
  const list = s.type === 'text' ? state.texts : state.clips;
  return list.find((i) => i.id === s.id) || null;
}

// ---- clip pieces and time ----
// Source time = seconds in the original file. Output time = seconds in the
// finished video, after deleted pieces are skipped and speeds applied.

export const MIN_PIECE = 0.1;
export const pieces = () => [...state.clips].sort((a, b) => a.start - b.start);

// The piece that plays at source time t, or null if t is in a deleted part.
export function pieceAt(t) {
  return state.clips.find((p) => t >= p.start && t < p.end) || null;
}

export function rateAt(t) {
  return pieceAt(t)?.rate || 1;
}

// Where playback should go from source time t: t itself if it's kept, otherwise
// the start of the next kept piece (null when nothing is left after t).
export function nextKept(t) {
  if (pieceAt(t)) return t;
  const next = pieces().find((p) => p.start >= t);
  return next ? next.start : null;
}

// Source time -> output time. Times inside a deleted part map to where the cut is.
export function srcToOut(t) {
  let out = 0;
  for (const p of pieces()) {
    if (t <= p.start) return out;
    if (t < p.end) return out + (t - p.start) / p.rate;
    out += (p.end - p.start) / p.rate;
  }
  return out;
}

// Output time -> source time. At the exact edge between two pieces, `next`
// picks the start of the later piece instead of the end of the earlier one.
export function outToSrc(o, next = false) {
  let out = 0;
  const list = pieces();
  for (const p of list) {
    const len = (p.end - p.start) / p.rate;
    if (next ? o < out + len : o <= out + len) return p.start + Math.max(0, o - out) * p.rate;
    out += len;
  }
  return list.length ? list[list.length - 1].end : 0;
}

export const outDuration = () => srcToOut(state.duration);

// Output-time edges of every piece: the snap points for text and emoji.
export function pieceEdgesOut() {
  const edges = [0];
  let out = 0;
  for (const p of pieces()) {
    out += (p.end - p.start) / p.rate;
    edges.push(out);
  }
  return edges;
}

// The kept pieces as segments for the exporters.
export function buildSegments() {
  return pieces().filter((p) => p.end - p.start > 0.01).map(({ start, end, rate }) => ({ start, end, rate }));
}

// ---- text animation (same curve the ffmpeg export uses) ----
// lt = seconds since the text appeared (output time), dur = how long it shows.
export function popScale(lt) {
  if (lt < 0.12) return 0.375 + (lt / 0.12) * 0.8125;
  if (lt < 0.22) return 1.1875 - ((lt - 0.12) / 0.1) * 0.1875;
  return 1;
}

export function fadeTime(dur) {
  return Math.min(0.3, dur / 3);
}

export function popAlpha(lt, dur) {
  const f = fadeTime(dur);
  return lt > dur - f ? clamp((dur - lt) / f, 0, 1) : 1;
}
