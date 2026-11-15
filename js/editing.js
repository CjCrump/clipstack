// Copy, cut, paste, duplicate, group and select-all for text and emoji.
// The clipboard lives in this tab only (it holds editor items, not system text).
//
// Paste and duplicate land at the playhead: the earliest copied item starts at the
// flag and the rest keep their timing relative to it. On screen they stay on the
// same spot of the footage as the originals. A copied group pastes as a new group.

import { state, emit, uid, srcToOut, outToSrc, outDuration, selectedTexts, selectOnly } from './state.js';
import { showStatus } from './status.js';

let video;
let clipboard = null; // copies of the items, as they were when copied

const clone = (t) => JSON.parse(JSON.stringify(t));
const count = (n) => `${n} item${n === 1 ? '' : 's'}`;

export function initEditing(v) {
  video = v;
}

export function copySelection() {
  const items = selectedTexts();
  if (!items.length) return false;
  clipboard = items.map(clone);
  showStatus(`Copied ${count(items.length)}. Ctrl+V pastes at the playhead.`);
  return true;
}

export function cutSelection() {
  const items = selectedTexts();
  if (!items.length) return;
  clipboard = items.map(clone);
  deleteTexts(items);
  showStatus(`Cut ${count(items.length)}. Ctrl+V pastes at the playhead.`);
}

export function deleteTexts(items) {
  const ids = new Set(items.map((t) => t.id));
  state.texts = state.texts.filter((t) => !ids.has(t.id));
  selectOnly(null);
  emit();
}

export function paste(items = clipboard) {
  if (!items?.length) {
    showStatus('Nothing copied yet. Select text or emoji and press Ctrl+C.');
    return;
  }
  const at = srcToOut(video.currentTime);
  const total = outDuration();
  const base = Math.min(...items.map((t) => srcToOut(t.start)));
  const groups = new Map(); // old group id -> new one, so a pasted group is its own group
  const made = [];
  for (const t of items) {
    const s = at + (srcToOut(t.start) - base);
    if (s >= total - 0.05) continue; // would start after the end of the video
    const len = Math.max(0.1, srcToOut(t.end) - srcToOut(t.start));
    const copy = { ...clone(t), id: uid() };
    if (t.group) {
      if (!groups.has(t.group)) groups.set(t.group, uid());
      copy.group = groups.get(t.group);
    }
    copy.start = outToSrc(s, true);
    copy.end = outToSrc(Math.min(total, s + len));
    state.texts.push(copy);
    made.push(copy);
  }
  if (!made.length) {
    showStatus('No room to paste there: move the playhead before the end of the video.');
    return;
  }
  state.selected = { type: 'text', id: made[0].id };
  state.multi = made.slice(1).map((t) => t.id);
  emit();
  showStatus(`Pasted ${count(made.length)} at the playhead.`);
}

// Ctrl+D: a copy of the selection at the playhead, without touching the clipboard.
export function duplicateSelection() {
  const items = selectedTexts();
  if (items.length) paste(items.map(clone));
}

export function groupSelection() {
  const items = selectedTexts();
  if (items.length < 2) {
    showStatus('Select two or more items to group: Ctrl or Shift + click them.');
    return;
  }
  const g = uid();
  for (const t of items) t.group = g;
  emit();
  showStatus(`Grouped ${count(items.length)}. They move, size and copy together. Ctrl+Shift+G ungroups.`);
}

export function ungroupSelection() {
  const items = selectedTexts();
  const grouped = items.filter((t) => t.group);
  if (!grouped.length) {
    showStatus('Nothing grouped is selected.');
    return;
  }
  for (const t of grouped) delete t.group;
  // keep them selected so they can be regrouped or moved
  state.multi = items.filter((t) => t.id !== state.selected?.id).map((t) => t.id);
  emit();
  showStatus(`Ungrouped ${count(grouped.length)}.`);
}

export function selectAllTexts() {
  if (!state.texts.length) return;
  state.selected = { type: 'text', id: state.texts[0].id };
  state.multi = state.texts.slice(1).map((t) => t.id);
  emit();
}
