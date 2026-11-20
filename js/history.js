// Undo and redo. Instead of every edit recording itself, this watches the edit
// and saves a snapshot once things settle, so a whole drag or a burst of typing
// becomes one undo step and new features get undo for free.

import { state, emit, subscribe } from './state.js';

const SETTLE_MS = 350; // quiet time before a change becomes an undo step
const LIMIT = 150;

const undoStack = []; // snapshots before the current one
const redoStack = [];
let current = null; // snapshot of the state as it is now
let timer = 0;
let restoring = false;
const listeners = new Set();

// Only the edit itself: not the selection, playhead or anything about the file.
const snap = () => JSON.stringify({
  split: state.split, boxA: state.boxA, boxB: state.boxB, texts: state.texts, clips: state.clips,
  facecam: state.facecam, boxASaved: state.boxASaved,
});

function commit() {
  clearTimeout(timer);
  const now = snap();
  if (now === current) return;
  if (current !== null) {
    undoStack.push(current);
    if (undoStack.length > LIMIT) undoStack.shift();
    redoStack.length = 0;
  }
  current = now;
  listeners.forEach((fn) => fn());
}

function restore(json) {
  restoring = true;
  const s = JSON.parse(json);
  Object.assign(state, s);
  // keep the selection only if that item still exists
  const sel = state.selected;
  if (sel && !(sel.type === 'text' ? state.texts : state.clips).some((i) => i.id === sel.id)) state.selected = null;
  current = json;
  emit();
  restoring = false;
  listeners.forEach((fn) => fn());
}

export function initHistory() {
  subscribe(() => {
    if (restoring || !state.duration || state.exporting) return;
    clearTimeout(timer);
    timer = setTimeout(commit, SETTLE_MS);
  });
}

// Start fresh, e.g. when a new clip is loaded.
export function resetHistory() {
  clearTimeout(timer);
  undoStack.length = 0;
  redoStack.length = 0;
  current = snap();
  listeners.forEach((fn) => fn());
}

export function undo() {
  commit(); // a change still settling counts as the last step
  if (!undoStack.length) return;
  redoStack.push(current);
  restore(undoStack.pop());
}

export function redo() {
  commit();
  if (!redoStack.length) return;
  undoStack.push(current);
  restore(redoStack.pop());
}

export const canUndo = () => undoStack.length > 0 || (current !== null && snap() !== current);
export const canRedo = () => redoStack.length > 0;
export const onHistoryChange = (fn) => listeners.add(fn);
