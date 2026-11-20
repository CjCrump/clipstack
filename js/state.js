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
  if (!state.facecam) return 'A'; // one crop shows the whole frame
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
  // false = No facecam: boxA alone is one 9:16 crop filling the whole frame.
  // boxB and split are left alone so switching back brings them back as they were.
  facecam: true,
  boxASaved: null, // Top box from before No facecam, put back when switching back
  // Overlay layers drawn over the video, in stacking order. Text: { id, text, ... }.
  // Emoji: { id, kind: 'emoji', file, label, ... }. Both share x, y (centre), size,
  // start, end and anim, so selecting, dragging and the timeline treat them the same.
  texts: [], // { id, kind?, text | file+label, x, y, size (source px), start, end (source s), anim }
  // The kept pieces of the source clip, in source seconds, in order and never
  // overlapping. Starts as one piece; Split cuts one in two, Delete removes one
  // (that part of the clip is skipped), and each piece has its own speed.
  clips: [], // { id, start, end, rate }
  selected: null, // { type: 'text' | 'clip', id }: the main selection, shown in Properties
  multi: [], // ids of other texts/emoji selected with it (Ctrl/Shift + click, Ctrl+A)
  // a text/emoji with item.group set belongs to that group: selecting one selects them all
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
// In No facecam mode Top's slot is the whole frame and Bottom's is empty.
export function slotH(k) {
  if (!state.facecam) return k === 'A' ? OUT_H : 0;
  return k === 'A' ? OUT_H * state.split : OUT_H * (1 - state.split);
}
export const boxH = (k) => (box(k).w * slotH(k)) / OUT_W;

// The biggest 9:16 crop, centred: where No facecam starts from the switch.
export function fullCrop() {
  const w = Math.min(state.srcW, (state.srcH * OUT_W) / OUT_H);
  return { x: (state.srcW - w) / 2, y: (state.srcH - (w * OUT_H) / OUT_W) / 2, w };
}

// Switch between two boxes (facecam) and one full-frame crop (no facecam).
// single: where the one crop goes; defaults to the biggest centred crop.
export function setFacecam(on, single = fullCrop()) {
  if (on === state.facecam) return;
  if (on) {
    if (state.boxASaved) state.boxA = state.boxASaved;
    state.boxASaved = null;
    state.facecam = true;
  } else {
    state.boxASaved = { ...state.boxA };
    state.boxA = { ...single };
    state.facecam = false;
  }
  clampBoxes();
  emit();
}

export function clampBoxes() {
  for (const k of state.facecam ? ['A', 'B'] : ['A']) {
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

// Every text/emoji in the selection: the main one, the extra ones, and everything
// grouped with any of them. The main one comes first.
export function selectedTexts() {
  const ids = new Set();
  if (state.selected?.type === 'text') ids.add(state.selected.id);
  for (const id of state.multi) ids.add(id);
  const picked = state.texts.filter((t) => ids.has(t.id));
  const groups = new Set(picked.map((t) => t.group).filter(Boolean));
  const all = state.texts.filter((t) => ids.has(t.id) || (t.group && groups.has(t.group)));
  const main = all.find((t) => t.id === state.selected?.id);
  return main ? [main, ...all.filter((t) => t !== main)] : all;
}
export const isSelected = (id) => selectedTexts().some((t) => t.id === id);

// Select just this item (clears any multi-selection).
export function selectOnly(type, id) {
  state.selected = id == null ? null : { type, id };
  state.multi = [];
}

// Ctrl/Shift + click: add a text/emoji to the selection, or take it (and its
// group) out if it's already in.
export function toggleSelect(id) {
  const t = state.texts.find((i) => i.id === id);
  if (!t) return;
  if (isSelected(id)) {
    const drop = new Set(state.texts.filter((i) => i.id === id || (t.group && i.group === t.group)).map((i) => i.id));
    state.multi = state.multi.filter((m) => !drop.has(m));
    if (drop.has(state.selected?.id)) {
      const next = state.multi.shift();
      state.selected = next != null ? { type: 'text', id: next } : null;
    }
    return;
  }
  if (state.selected?.type === 'text') state.multi.push(id);
  else state.selected = { type: 'text', id };
}

// Make an already-selected item the main one (Properties shows it, its corner
// handle scales the group) without dropping the rest of the selection.
export function makeMain(id) {
  if (state.selected?.type === 'text' && state.selected.id !== id) {
    state.multi = [...state.multi.filter((m) => m !== id), state.selected.id];
  }
  state.selected = { type: 'text', id };
}

// ---- tracks ----
// Text and emoji each share rows: item.track is the row number within its kind.
// Two items on one row never overlap in time.
export const kindOf = (t) => (t.kind === 'emoji' ? 'emoji' : 'text');
const overlaps = (a, b) => a.start < b.end - 1e-6 && b.start < a.end - 1e-6;

// Can `item` sit on row `n` of its kind without overlapping anything there?
export function trackFree(item, n) {
  return !state.texts.some((o) => o !== item && kindOf(o) === kindOf(item) && o.track === n && overlaps(o, item));
}

// Give every item a row: new ones (no track yet) and ones that now overlap
// something go to the lowest free row; `moved` ids are the ones that give way.
// Then empty rows are removed so the numbers stay 0, 1, 2...
export function tidyTracks(moved = []) {
  const late = new Set(moved);
  for (const kind of ['text', 'emoji']) {
    const items = state.texts.filter((t) => kindOf(t) === kind);
    const order = [...items].sort((a, b) =>
      (late.has(a.id) - late.has(b.id)) || ((a.track ?? 1e9) - (b.track ?? 1e9)) || (a.start - b.start));
    const placed = [];
    for (const t of order) {
      const clash = (n) => placed.some((o) => o.track === n && overlaps(o, t));
      if (t.track == null || clash(t.track)) {
        let n = 0;
        while (clash(n)) n++;
        t.track = n;
      }
      placed.push(t);
    }
    const used = [...new Set(items.map((t) => t.track))].sort((a, b) => a - b);
    for (const t of items) t.track = used.indexOf(t.track);
  }
}

// ---- moving and scaling a selection together ----
// Drags take a snapshot when they start, then apply one move or scale to all of it.
export const snapshotItems = (items) => items.map((it) => ({ it, x: it.x, y: it.y, size: it.size }));

export function moveItems(snap, dx, dy) {
  for (const s of snap) {
    s.it.x = clamp(s.x + dx, 0, state.srcW);
    s.it.y = clamp(s.y + dy, 0, state.srcH);
  }
}

// Scale sizes and spacing by f around `anchor` (a footage point), so a group
// grows or shrinks as one. f is limited so no item goes past the size limits.
export function scaleItems(snap, anchor, f) {
  let lo = 0;
  let hi = Infinity;
  for (const s of snap) {
    lo = Math.max(lo, MIN_SIZE / s.size);
    hi = Math.min(hi, MAX_SIZE / s.size);
  }
  const k = clamp(f, lo, hi);
  for (const s of snap) {
    s.it.size = s.size * k;
    s.it.x = clamp(anchor.x + (s.x - anchor.x) * k, 0, state.srcW);
    s.it.y = clamp(anchor.y + (s.y - anchor.y) * k, 0, state.srcH);
  }
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
