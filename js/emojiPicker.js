// Emoji picker, built inside the app's dialog. Search by name or keyword, browse by
// category, pick a skin tone. Keyboard: Tab between search, tones, tabs and grid;
// arrows move inside the grid; Enter or Space picks.

import { emojiUrl, loadEmojiIndex } from './emoji.js';

const MAX_RESULTS = 240; // search results shown at once; typing more narrows it
const TONES = [
  { label: 'Default', swatch: '#ffcc33' },
  { label: 'Light', swatch: '#f7d7c4' },
  { label: 'Medium-light', swatch: '#d8b094' },
  { label: 'Medium', swatch: '#bb9167' },
  { label: 'Medium-dark', swatch: '#8e562e' },
  { label: 'Dark', swatch: '#613d30' },
];

let tone = 0; // remembered while the page is open, never saved

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};

// Builds the picker in `container`. onPick({ file, label }) runs when one is chosen.
export async function buildEmojiPicker(container, onPick) {
  container.textContent = 'Loading emoji…';
  let data;
  try {
    data = await loadEmojiIndex();
  } catch (err) {
    container.textContent = err.message;
    return;
  }
  container.textContent = '';

  const groupIds = Object.keys(data.groups).map(Number);
  let group = groupIds[0];
  const entries = data.emoji.map(([file, label, keywords, g, tones], order) => ({
    file, label, g, tones, order,
    name: label.toLowerCase(),
    nameWords: label.toLowerCase().split(/[\s:,-]+/),
    tags: keywords.toLowerCase().split(/\s+/),
  }));
  // a search word matches when a word of the name or a keyword starts with it,
  // so "gg" doesn't match the middle of "hugging"
  const hits = (e, t) => e.nameWords.some((w) => w.startsWith(t)) || e.tags.some((w) => w.startsWith(t));

  // Best matches first: exact name, name starting with it, a word of the name
  // starting with it, an exact keyword, then the rest. Ties keep Unicode order.
  const rank = (e, q) => {
    if (e.name === q) return 0;
    if (e.name.startsWith(q)) return 1;
    if (e.nameWords.some((w) => w.startsWith(q))) return 2;
    if (e.tags.includes(q)) return 3;
    return 4;
  };

  const wrap = el('div', 'emoji-picker');
  const search = el('input', 'emoji-search');
  search.type = 'search';
  search.placeholder = 'Search: fire, laugh, skull…';
  search.setAttribute('aria-label', 'Search emoji');
  search.dataset.hint = 'Type a name or a word like laugh, fire or skull. Down arrow jumps into the results.';

  const tones = el('div', 'emoji-tones');
  tones.setAttribute('role', 'group');
  tones.setAttribute('aria-label', 'Skin tone');
  TONES.forEach((t, i) => {
    const b = el('button', 'emoji-tone');
    b.type = 'button';
    b.style.setProperty('--swatch', t.swatch);
    b.setAttribute('aria-label', `${t.label} skin tone`);
    b.dataset.hint = i ? `${t.label} skin tone, for emoji that have one.` : 'Default yellow, no skin tone.';
    b.addEventListener('click', () => { tone = i; syncTones(); draw(); });
    tones.appendChild(b);
  });
  const syncTones = () => [...tones.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === tone)));

  const tabs = el('div', 'emoji-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', 'Categories');
  for (const id of groupIds) {
    const b = el('button', 'emoji-tab', data.groups[id]);
    b.type = 'button';
    b.dataset.group = id;
    b.dataset.hint = `Browse ${data.groups[id].toLowerCase()}.`;
    b.addEventListener('click', () => { group = id; search.value = ''; draw(); });
    tabs.appendChild(b);
  }

  const status = el('p', 'emoji-status muted');
  status.setAttribute('aria-live', 'polite');
  const grid = el('div', 'emoji-grid');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Emoji');

  wrap.append(search, tones, tabs, status, grid);
  container.appendChild(wrap);

  const fileFor = (e) => (tone && e.tones ? e.tones[tone - 1] : e.file);

  function draw() {
    const q = search.value.trim().toLowerCase();
    let list;
    if (q) {
      const terms = q.split(/\s+/);
      list = entries.filter((e) => terms.every((t) => hits(e, t)))
        .sort((x, y) => rank(x, q) - rank(y, q) || x.order - y.order);
    } else {
      list = entries.filter((e) => e.g === group);
    }
    [...tabs.children].forEach((b) => b.setAttribute('aria-pressed', String(!q && Number(b.dataset.group) === group)));
    status.textContent = q
      ? (list.length ? `${list.length} match${list.length === 1 ? '' : 'es'}${list.length > MAX_RESULTS ? `, showing ${MAX_RESULTS}` : ''}` : 'No emoji match that. Try a simpler word.')
      : `${data.groups[group]}: ${list.length}`;

    grid.textContent = '';
    list.slice(0, MAX_RESULTS).forEach((e, i) => {
      const file = fileFor(e);
      const b = el('button', 'emoji-cell');
      b.type = 'button';
      b.tabIndex = i === 0 ? 0 : -1; // one tab stop; arrows move inside
      b.title = e.label;
      b.setAttribute('aria-label', e.label);
      const img = el('img');
      img.alt = '';
      img.width = 36;
      img.height = 36;
      img.loading = 'lazy';
      img.src = emojiUrl(file);
      b.appendChild(img);
      b.addEventListener('click', () => onPick({ file, label: e.label }));
      grid.appendChild(b);
    });
  }

  // Roving focus: arrows move between cells, Home/End jump to the ends.
  grid.addEventListener('keydown', (ev) => {
    const cells = [...grid.children];
    const i = cells.indexOf(document.activeElement);
    if (i < 0) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length || 1;
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: cells.length - 1 }[ev.key];
    if (to === undefined) return;
    ev.preventDefault();
    const next = cells[Math.max(0, Math.min(cells.length - 1, to))];
    cells[i].tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  // Down arrow from the search box drops into the results
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' && grid.firstElementChild) {
      ev.preventDefault();
      grid.firstElementChild.focus();
    }
  });
  search.addEventListener('input', draw);

  syncTones();
  draw();
  search.focus();
}
