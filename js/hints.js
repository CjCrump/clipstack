// Hints: every control carries a short data-hint. It shows in one floating tip on
// hover (after a short pause) or when you Tab to the control, and screen readers
// get it as the control's description. Esc hides it, and you can move the pointer
// onto the tip without it closing.
//
//   data-hint="..."           the hint
//   data-hint-disabled="..."  added to the hint while the control is disabled
//   data-hint-focus="only"    keyboard focus only: for big drag areas (preview,
//                             crop boxes, ruler) where a hover tip gets in the way
//
// The tip is one fixed element on <body>, so panes that clip their overflow
// can't cut it off.

const SHOW_DELAY = 450; // ms of hovering before the tip appears

const tip = document.createElement('div');
tip.className = 'hint-tip';
tip.setAttribute('role', 'tooltip');
tip.hidden = true;

const texts = document.createElement('div'); // hidden descriptions for screen readers
texts.hidden = true;

let current = null;
let timer = 0;
let n = 0;

const textFor = (el) => {
  const extra = el.disabled && el.dataset.hintDisabled ? ` ${el.dataset.hintDisabled}` : '';
  return `${el.dataset.hint}${extra}`;
};

// Link an element's hint to a hidden description so screen readers read it too.
function describe(el) {
  if (!el.dataset.hint) return;
  let span = el.hintSpan;
  if (!span) {
    span = document.createElement('span');
    span.id = `hint-${++n}`;
    texts.appendChild(span);
    el.hintSpan = span;
    // a hint on a <label> describes the field inside it, which is what gets focus
    const target = el.tagName === 'LABEL' ? el.querySelector('input, select, textarea') || el : el;
    const ids = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    target.setAttribute('aria-describedby', [...ids, span.id].join(' '));
  }
  span.textContent = textFor(el);
}

function scan(root) {
  if (root.matches?.('[data-hint]')) describe(root);
  root.querySelectorAll?.('[data-hint]').forEach(describe);
}

function show(el) {
  clearTimeout(timer);
  if (!el.isConnected || !el.dataset.hint) return;
  current = el;
  tip.textContent = textFor(el);
  tip.style.left = '0px'; // measure at full width before placing it
  tip.style.top = '0px';
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let top = r.bottom + 8;
  if (top + h > innerHeight - 6) top = r.top - h - 8; // no room below: go above
  const left = Math.max(6, Math.min(innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(6, top)}px`;
}

function hide() {
  clearTimeout(timer);
  current = null;
  tip.hidden = true;
}

export function initHints() {
  document.body.append(tip, texts);
  scan(document.body);

  // panel, timeline and picker rebuild their controls, so watch for new hints
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') describe(m.target);
      else m.addedNodes.forEach((node) => { if (node.nodeType === 1) scan(node); });
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-hint', 'disabled'] });

  document.addEventListener('pointerover', (e) => {
    if (tip.contains(e.target)) { clearTimeout(timer); return; } // reading the tip keeps it open
    const el = e.target.closest('[data-hint]');
    if (el === current) return;
    clearTimeout(timer);
    if (!el || el.dataset.hintFocus === 'only') {
      if (current && !current.matches(':focus-visible')) hide();
      return;
    }
    timer = setTimeout(() => show(el), SHOW_DELAY);
  });
  document.addEventListener('pointerdown', (e) => { if (!tip.contains(e.target)) hide(); }, true);
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest('[data-hint]');
    if (el && el.matches(':focus-visible')) show(el);
    else hide();
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  addEventListener('scroll', hide, true);
  addEventListener('resize', hide);
}
