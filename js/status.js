// Short messages in the notice bar under the toolbar, gone after a few seconds.

const SHOW_MS = 4500;
let timer = 0;
const lastShown = new Map(); // message -> time, so repeats don't nag

// once: don't show the same message again within this many ms
export function showStatus(msg, once = 0) {
  const now = Date.now();
  if (once && now - (lastShown.get(msg) || 0) < once) return;
  lastShown.set(msg, now);
  const n = document.getElementById('notice');
  n.textContent = msg;
  n.className = 'notice info';
  n.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { n.hidden = true; }, SHOW_MS);
}

export const OVERLAP_MSG = 'Two items overlap here. To pick the one underneath, click its bar on the timeline.';
