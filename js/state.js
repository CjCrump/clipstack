// Shared app state, change notifications, and time/geometry helpers.

export const OUT_W = 1080;
export const OUT_H = 1920;

export const state = {
  fileName: 'clip.mp4',
  srcW: 1920,
  srcH: 1080,
  duration: 0,
  split: 0.68, // fraction of the output height used by the top box
  boxA: { x: 542, y: 41, w: 835 }, // top slot (gameplay), source pixels
  boxB: { x: 36, y: 730, w: 562 }, // bottom slot (facecam), source pixels
  texts: [], // { id, text, x, y, size, start, end, anim }
  speeds: [], // { id, start, end, rate }
  selected: null, // { type: 'text' | 'speed', id }
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
  const list = s.type === 'text' ? state.texts : state.speeds;
  return list.find((i) => i.id === s.id) || null;
}

// ---- speed segments ----
export const sortedSpeeds = () => [...state.speeds].sort((a, b) => a.start - b.start);

export function rateAt(t) {
  for (const s of state.speeds) if (t >= s.start && t < s.end) return s.rate;
  return 1;
}

// Source time -> output time, after speed segments are applied.
export function srcToOut(t) {
  let out = 0;
  let cur = 0;
  for (const s of sortedSpeeds()) {
    if (t <= s.start) break;
    out += s.start - cur;
    if (t < s.end) return out + (t - s.start) / s.rate;
    out += (s.end - s.start) / s.rate;
    cur = s.end;
  }
  return out + (t - cur);
}

// Output time -> source time (the reverse of srcToOut).
export function outToSrc(o) {
  let out = 0;
  let cur = 0;
  for (const s of sortedSpeeds()) {
    const gap = s.start - cur;
    if (o <= out + gap) return cur + (o - out);
    out += gap;
    const segOut = (s.end - s.start) / s.rate;
    if (o <= out + segOut) return s.start + (o - out) * s.rate;
    out += segOut;
    cur = s.end;
  }
  return cur + (o - out);
}

// Every stretch of the clip with its playback rate, gaps filled with 1x.
export function buildSegments() {
  const segs = [];
  let cur = 0;
  for (const s of sortedSpeeds()) {
    if (s.start > cur) segs.push({ start: cur, end: s.start, rate: 1 });
    segs.push({ start: s.start, end: s.end, rate: s.rate });
    cur = s.end;
  }
  if (cur < state.duration) segs.push({ start: cur, end: state.duration, rate: 1 });
  return segs.filter((s) => s.end - s.start > 0.01);
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
