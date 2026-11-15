// Emoji layers use Google's Noto emoji (Apache 2.0), served from vendor/noto-emoji/.
// Nothing here loads until someone opens the picker or a clip has an emoji, so the
// editor starts as fast as before.

const BASE = 'vendor/noto-emoji/';
const FILE_RE = /^[0-9a-f]{4,6}(_[0-9a-f]{4,6})*$/; // index file names: hex codepoints joined by _

const images = new Map(); // file -> HTMLImageElement

export const emojiUrl = (file) => (FILE_RE.test(file) ? `${BASE}svg/${file}.svg` : '');

// The image for a file, starting the download the first time.
// Returns null until it has loaded, so callers just skip drawing for that frame.
export function emojiImage(file) {
  let img = images.get(file);
  if (!img) {
    const url = emojiUrl(file);
    if (!url) return null;
    img = new Image();
    img.decoding = 'async';
    img.src = url;
    images.set(file, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

// Waits until every emoji in the list can be drawn. The MP4 export calls this first
// so no frame is ever written with a missing emoji.
export async function emojiReady(files) {
  await Promise.all([...new Set(files)].map(async (file) => {
    emojiImage(file);
    const img = images.get(file);
    if (!img) throw new Error(`Unknown emoji "${file}"`);
    try {
      await img.decode();
    } catch {
      throw new Error('An emoji image failed to load. Check your connection and try again.');
    }
  }));
}

// { groups: { id: name }, emoji: [[file, label, keywords, group, tones?], ...] }
let indexPromise = null;
export function loadEmojiIndex() {
  indexPromise ??= fetch(`${BASE}index.json`).then((r) => {
    if (!r.ok) throw new Error(`Emoji list failed to load (HTTP ${r.status})`);
    return r.json();
  }).catch((err) => {
    indexPromise = null; // let the next open try again
    throw err;
  });
  return indexPromise;
}
