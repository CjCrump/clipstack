// Properties panel for the selected text, emoji or speed segment.
// Rebuilt only when the selection changes so typing never loses focus.

import { state, emit, subscribe, getSelected, pieces, OUT_W, OUT_H, srcToOut, outToSrc, outDuration } from './state.js';
import { MAX_TEXT } from './exportFfmpeg.js';
import { emojiUrl } from './emoji.js';

const RATES = [1, 1.5, 2, 3, 4, 8];

const SIZE_TEXT = 'Letter height in pixels, 30 to 400.';
const SIZE_EMOJI = 'Width and height in pixels, 30 to 400.';
const START_HINT = 'When it appears, in seconds of the finished video (what the timeline shows).';
const END_HINT = 'When it disappears, in seconds of the finished video.';
const DELETE_HINT = 'Remove it. The Delete key does the same.';

// Position, size, timing and animation: the same for text and emoji
const placeFields = (sizeHint) => `
      <div class="row">
        <label data-hint="Centre of it, across: 0% is the left edge, 100% the right. The same spot in the vertical and horizontal video.">X (%) <input data-k="xp" type="number" min="0" max="100" step="1"></label>
        <label data-hint="Centre of it, down: 0% is the top, 100% the bottom. The same spot in the vertical and horizontal video.">Y (%) <input data-k="yp" type="number" min="0" max="100" step="1"></label>
      </div>
      <label data-hint="${sizeHint}">Size <input data-k="size" type="number" min="30" max="400" step="2"></label>
      <div class="row">
        <label data-hint="${START_HINT}">Start (s) <input data-k="so" type="number" step="0.05" min="0"></label>
        <label data-hint="${END_HINT}">End (s) <input data-k="eo" type="number" step="0.05" min="0"></label>
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
      // Start/End are shown in finished-video seconds; stored in source seconds
      if (k === 'so' || k === 'eo') {
        delete it[k];
        const o = Math.min(outDuration(), Math.max(0, v));
        if (k === 'so') it.start = outToSrc(o, true);
        else it.end = outToSrc(o);
      }
      if (k === 'size') it.size = Math.min(400, Math.max(30, it.size));
      // X/Y are shown as % of the frame; stored in vertical-frame pixels (see placeIn)
      if (k === 'xp' || k === 'yp') {
        delete it[k];
        const pct = Math.min(100, Math.max(0, v));
        if (k === 'xp') it.x = (pct / 100) * OUT_W;
        else it.y = (pct / 100) * OUT_H;
      }
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
    const k = input.dataset.k;
    if (k === 'xp' || k === 'yp') {
      input.value = Math.round(k === 'xp' ? (item.x / OUT_W) * 100 : (item.y / OUT_H) * 100);
      return;
    }
    if (k === 'so' || k === 'eo') {
      input.value = srcToOut(k === 'so' ? item.start : item.end).toFixed(2);
      return;
    }
    const v = item[k];
    input.value = typeof v === 'number' && k !== 'rate' && k !== 'size' ? v.toFixed(2) : v;
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
