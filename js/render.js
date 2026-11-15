// Draws one finished output frame: both crops stacked, then the text and emoji layers.
// Shared by the live preview and the exporter so they always match.

import { state, OUT_W, OUT_H, box, slotH, boxH, srcToOut, popScale, popAlpha } from './state.js';
import { emojiImage } from './emoji.js';

export const FONT = 'Bangers, Impact, sans-serif';

// drawCrop(ctx, sx, sy, sw, sh, dx, dy, dw, dh) copies part of the source frame.
// It's a callback so the preview can pass the <video> and the exporter a decoded frame.
// Returns nothing; pass drawCrop = null to draw text only (no frame ready yet).
export function drawComposite(ctx, drawCrop, t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);

  if (drawCrop) {
    const topH = Math.round(slotH('A'));
    const a = box('A');
    const b = box('B');
    drawCrop(ctx, a.x, a.y, a.w, boxH('A'), 0, 0, OUT_W, topH);
    drawCrop(ctx, b.x, b.y, b.w, boxH('B'), 0, topH, OUT_W, OUT_H - topH);
  }

  for (const tx of state.texts) {
    const v = textVisual(tx, t);
    if (v) drawText(ctx, tx, v.scale, v.alpha);
  }
}

// How a text layer looks at source time t, or null if it's not on screen.
export function textVisual(tx, t) {
  if (t < tx.start || t > tx.end) return null;
  const t0 = srcToOut(tx.start);
  const lt = srcToOut(t) - t0;
  const dur = srcToOut(tx.end) - t0;
  return { scale: tx.anim === 'pop' ? popScale(lt) : 1, alpha: popAlpha(lt, dur) };
}

export function drawText(ctx, tx, scale, alpha) {
  if (tx.kind === 'emoji') return drawEmoji(ctx, tx, scale, alpha);
  const size = tx.size * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = size / 8; // matches ffmpeg borderw = size/16 per side
  ctx.strokeStyle = '#000';
  ctx.strokeText(tx.text, tx.x, tx.y);
  ctx.fillStyle = '#fff';
  ctx.fillText(tx.text, tx.x, tx.y);
  ctx.restore();
}

// Emoji are drawn size x size around their centre, so they scale like text does.
function drawEmoji(ctx, em, scale, alpha) {
  const img = emojiImage(em.file);
  if (!img) return; // still loading; the preview draws it on a later frame
  const s = em.size * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(img, em.x - s / 2, em.y - s / 2, s, s);
  ctx.restore();
}
