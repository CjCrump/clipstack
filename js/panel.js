// Properties panel for the selected text, emoji or speed segment.
// Rebuilt only when the selection changes so typing never loses focus.

import { state, emit, subscribe, getSelected, pieces, srcToOut, outToSrc, outDuration, MIN_SIZE, MAX_SIZE, selectedTexts } from './state.js';
import { copySelection, duplicateSelection, groupSelection, ungroupSelection, deleteTexts } from './editing.js';
import { MAX_TEXT } from './exportFfmpeg.js';
import { emojiUrl } from './emoji.js';

const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];

const SIZE_TEXT = `Letter height in pixels on the horizontal video, ${MIN_SIZE} to ${MAX_SIZE}. Vertical scales it with the crop zoom so it covers the same spot.`;
const SIZE_EMOJI = `Width and height in pixels on the horizontal video, ${MIN_SIZE} to ${MAX_SIZE}. Vertical scales it with the crop zoom so it covers the same spot.`;
const START_HINT = 'When it appears, in seconds of the finished video (what the timeline shows).';
const END_HINT = 'When it disappears, in seconds of the finished video.';
const DELETE_HINT = 'Remove it. The Delete key does the same.';

// Position, size, timing and animation: the same for text and emoji
const placeFields = (sizeHint) => `
      <div class="row">
        <label data-hint="Where it sits on your clip, across: 0% is the left edge, 100% the right. It stays on that spot of the footage in both videos.">X (%) <input data-k="xp" type="number" min="0" max="100" step="1"></label>
        <label data-hint="Where it sits on your clip, down: 0% is the top, 100% the bottom. It stays on that spot of the footage in both videos.">Y (%) <input data-k="yp" type="number" min="0" max="100" step="1"></label>
      </div>
      <label data-hint="${sizeHint}">Size <input data-k="size" type="number" min="${MIN_SIZE}" max="${MAX_SIZE}" step="2"></label>
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
  const sel = selectedTexts();
  const multi = `${sel.length}:${sel.map((t) => t.group || 0).join(',')}`; // rebuild when the selection or grouping changes
  const key = item ? `${state.selected.type}:${item.id}:${item.file || ''}:${state.clips.length}:${multi}` : null;
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
      <label data-hint="How fast this piece plays: below 1x is slow motion, above 1x speeds it up. Voices keep their pitch.">Speed <select data-k="rate">${RATES.map((r) => `<option value="${r}">${r}x</option>`).join('')}</select></label>
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
      if (k === 'size') it.size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, it.size));
      // X/Y are shown as % of the clip; stored in source pixels (see placeIn)
      if (k === 'xp' || k === 'yp') {
        delete it[k];
        const pct = Math.min(100, Math.max(0, v));
        if (k === 'xp') it.x = (pct / 100) * state.srcW;
        else it.y = (pct / 100) * state.srcH;
      }
      if (it.end <= it.start) it.end = it.start + 0.1;
      emit();
    });
  });
  root.querySelector('[data-act="delete"]').addEventListener('click', deleteSelected);
  if (state.selected.type === 'text') addMultiBlock();
}

function sync(item) {
  if (!item) return;
  root.querySelectorAll('[data-k]').forEach((input) => {
    if (input === document.activeElement) return;
    const k = input.dataset.k;
    if (k === 'xp' || k === 'yp') {
      input.value = Math.round(k === 'xp' ? (item.x / state.srcW) * 100 : (item.y / state.srcH) * 100);
      return;
    }
    if (k === 'so' || k === 'eo') {
      input.value = srcToOut(k === 'so' ? item.start : item.end).toFixed(2);
      return;
    }
    const v = item[k];
    input.value = k === 'size' ? Math.round(v) : typeof v === 'number' && k !== 'rate' ? v.toFixed(2) : v;
  });
}

// With more than one text/emoji selected: a summary on top, with group, copy and
// delete for all of them. The fields below still edit the main (first-clicked) one.
function addMultiBlock() {
  const sel = selectedTexts();
  if (sel.length < 2) return;
  const grouped = sel.every((t) => t.group && t.group === sel[0].group);
  root.insertAdjacentHTML('afterbegin', `
    <div class="multi-sel">
      <p class="multi-count"></p>
      <div class="multi-btns">
        ${grouped
          ? '<button class="btn" data-act="ungroup" data-hint="Split the group so each item moves and sizes on its own (Ctrl+Shift+G).">Ungroup</button>'
          : '<button class="btn" data-act="group" data-hint="Lock these together: they move, size and copy as one (Ctrl+G).">Group</button>'}
        <button class="btn" data-act="copy" data-hint="Copy them (Ctrl+C). Ctrl+V pastes at the playhead.">Copy</button>
        <button class="btn" data-act="dup" data-hint="Put a copy of them at the playhead (Ctrl+D).">Duplicate</button>
      </div>
      <p class="muted">Fields below edit the one you clicked.</p>
    </div>`);
  root.querySelector('.multi-count').textContent = `${sel.length} selected${grouped ? ' · grouped' : ''}`;
  const act = (name, fn) => root.querySelector(`[data-act="${name}"]`)?.addEventListener('click', fn);
  act('group', groupSelection);
  act('ungroup', ungroupSelection);
  act('copy', copySelection);
  act('dup', duplicateSelection);
  const del = root.querySelector('[data-act="delete"]');
  del.textContent = `Delete ${sel.length} items`;
  del.dataset.hint = 'Remove everything selected. The Delete key does the same; Ctrl+Z brings it back.';
}

export function deleteSelected() {
  if (state.selected?.type === 'text' || state.multi.length) {
    const sel = selectedTexts();
    if (sel.length) {
      deleteTexts(sel);
      return;
    }
  }
  const s = state.selected;
  if (!s) return;
  if (s.type === 'clip' && state.clips.length <= 1) return; // something has to stay
  const key = s.type === 'text' ? 'texts' : 'clips';
  state[key] = state[key].filter((i) => i.id !== s.id);
  state.selected = null;
  emit();
}
