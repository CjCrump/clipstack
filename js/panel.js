// Properties panel for the selected text, emoji or speed segment.
// Rebuilt only when the selection changes so typing never loses focus.

import { state, emit, subscribe, getSelected, pieces } from './state.js';
import { MAX_TEXT } from './exportFfmpeg.js';
import { emojiUrl } from './emoji.js';

const RATES = [1, 1.5, 2, 3, 4, 8];

const SIZE_TEXT = 'Letter height in pixels, 30 to 400.';
const SIZE_EMOJI = 'Width and height in pixels, 30 to 400.';
const START_HINT = 'When it appears, in seconds of your original clip.';
const END_HINT = 'When it disappears, in seconds of your original clip.';
const DELETE_HINT = 'Remove it. The Delete key does the same.';

// Position, size, timing and animation: the same for text and emoji
const placeFields = (sizeHint) => `
      <div class="row">
        <label data-hint="Centre of it, across. 0 is the left edge, 1080 the right.">X <input data-k="x" type="number" min="0" max="1080" step="10"></label>
        <label data-hint="Centre of it, down. 0 is the top, 1920 the bottom.">Y <input data-k="y" type="number" min="0" max="1920" step="10"></label>
      </div>
      <label data-hint="${sizeHint}">Size <input data-k="size" type="number" min="30" max="400" step="2"></label>
      <div class="row">
        <label data-hint="${START_HINT}">Start (s) <input data-k="start" type="number" step="0.05" min="0"></label>
        <label data-hint="${END_HINT}">End (s) <input data-k="end" type="number" step="0.05" min="0"></label>
      </div>
      <label data-hint="Pop bounces it in. Either way it fades out at the end.">Animation
        <select data-k="anim"><option value="pop">Pop</option><option value="none">None</option></select>
      </label>`;

let root;
let shownKey; // undefined so the first render always builds
let onChangeEmoji = () => {};

// opts.onChangeEmoji(item) opens the picker to swap the selected emoji
export function initPanel(el, opts = {}) {
  root = el;
  if (opts.onChangeEmoji) onChangeEmoji = opts.onChangeEmoji;
  subscribe(render);
  render();
}

function render() {
  const item = getSelected();
  const key = item ? `${state.selected.type}:${item.id}:${item.file || ''}:${state.clips.length}` : null;
  if (key !== shownKey) {
    shownKey = key;
    build(item);
  }
  sync(item);
}

function build(item) {
  if (!item) {
    root.innerHTML = '<p class="muted">Select a clip piece, text or emoji on the timeline (click it, or Tab to it) to edit it. Drag text or emoji in the preview to move it, and use its corner handle to resize. S splits the clip at the playhead.</p>';
    return;
  }
  if (state.selected.type === 'text' && item.kind === 'emoji') {
    root.innerHTML = `
      <div class="emoji-current"><img alt="" width="44" height="44"><span></span></div>
      <button class="btn" data-act="change" data-hint="Swap it for another emoji. Position and timing stay.">Change emoji</button>
${placeFields(SIZE_EMOJI)}
      <button class="btn danger" data-act="delete" data-hint="${DELETE_HINT}">Delete emoji</button>`;
    root.querySelector('.emoji-current img').src = emojiUrl(item.file);
    root.querySelector('.emoji-current span').textContent = item.label;
    root.querySelector('[data-act="change"]').addEventListener('click', () => onChangeEmoji(item));
  } else if (state.selected.type === 'text') {
    root.innerHTML = `
      <label data-hint="What it says, up to ${MAX_TEXT} characters.">Text <textarea data-k="text" rows="2" maxlength="${MAX_TEXT}"></textarea></label>
${placeFields(SIZE_TEXT)}
      <button class="btn danger" data-act="delete" data-hint="${DELETE_HINT}">Delete text</button>`;
  } else {
    const list = pieces();
    const only = list.length === 1;
    root.innerHTML = `
      <p class="piece-info"></p>
      <label data-hint="How much faster this piece plays. Voices keep their pitch.">Speed <select data-k="rate">${RATES.map((r) => `<option value="${r}">${r}x</option>`).join('')}</select></label>
      <button class="btn danger" data-act="delete" ${only ? 'disabled' : ''}
        data-hint="Cut this piece out of the video. Everything after it slides left. The Delete key does the same. Ctrl+Z brings it back."
        data-hint-disabled="Split the clip first: there has to be something left.">Delete piece</button>`;
    const n = list.indexOf(item) + 1;
    root.querySelector('.piece-info').textContent =
      `Piece ${n} of ${list.length}: ${item.start.toFixed(2)}s to ${item.end.toFixed(2)}s of your clip. ` +
      'Split with S at the playhead to make more pieces.';
  }

  root.querySelectorAll('[data-k]').forEach((input) => {
    input.addEventListener('input', () => {
      const it = getSelected();
      if (!it) return;
      const k = input.dataset.k;
      const numeric = k !== 'text' && k !== 'anim';
      const v = numeric ? parseFloat(input.value) : input.value;
      if (numeric && Number.isNaN(v)) return;
      it[k] = k === 'text' ? v.slice(0, MAX_TEXT) : v;
      if (k === 'start' || k === 'end') it[k] = Math.min(state.duration, Math.max(0, it[k]));
      if (k === 'size') it.size = Math.min(400, Math.max(30, it.size));
      if (k === 'x') it.x = Math.min(1080, Math.max(0, it.x));
      if (k === 'y') it.y = Math.min(1920, Math.max(0, it.y));
      if (it.end <= it.start) it.end = it.start + 0.1;
      emit();
    });
  });
  root.querySelector('[data-act="delete"]').addEventListener('click', deleteSelected);
}

function sync(item) {
  if (!item) return;
  root.querySelectorAll('[data-k]').forEach((input) => {
    if (input === document.activeElement) return;
    const v = item[input.dataset.k];
    const k = input.dataset.k;
    if (k === 'x' || k === 'y') input.value = Math.round(v);
    else input.value = typeof v === 'number' && k !== 'rate' && k !== 'size' ? v.toFixed(2) : v;
  });
}

export function deleteSelected() {
  const s = state.selected;
  if (!s) return;
  if (s.type === 'clip' && state.clips.length <= 1) return; // something has to stay
  const key = s.type === 'text' ? 'texts' : 'clips';
  state[key] = state[key].filter((i) => i.id !== s.id);
  state.selected = null;
  emit();
}
