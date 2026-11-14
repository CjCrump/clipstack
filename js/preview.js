// Builds an ffmpeg filter script + command that renders exactly what the preview shows.
// The filter lives in its own file so the command works the same in PowerShell, cmd and bash.

import { state, OUT_W, OUT_H, box, boxH, slotH, srcToOut, buildSegments, fadeTime } from './state.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const f = (n) => Number(n.toFixed(3));

// atempo only takes 0.5..2 per instance, so chain it for bigger speedups.
function atempo(rate) {
  const parts = [];
  let r = rate;
  while (r > 2) {
    parts.push('atempo=2');
    r /= 2;
  }
  if (r !== 1) parts.push(`atempo=${f(r)}`);
  return parts.length ? `,${parts.join(',')}` : '';
}

function cropFor(k) {
  const b = box(k);
  return `crop=${even(b.w)}:${even(boxH(k))}:${Math.round(b.x)}:${Math.round(b.y)}`;
}

function escapeFontPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

function drawtext(tx, fontPath) {
  const T = f(srcToOut(tx.start));
  const D = f(srcToOut(tx.end) - srcToOut(tx.start));
  const S = tx.size;
  const fade = f(fadeTime(D));
  const lt = `(t-${T})`;

  const size = tx.anim === 'pop'
    ? `if(lt(${lt}\\,0.12)\\,${f(S * 0.375)}+${lt}/0.12*${f(S * 0.8125)}\\,` +
      `if(lt(${lt}\\,0.22)\\,${f(S * 1.1875)}-(${lt}-0.12)/0.1*${f(S * 0.1875)}\\,${S}))`
    : `${S}`;
  const alpha = `if(lt(${lt}\\,${f(D - fade)})\\,1\\,(${f(T + D)}-t)/${fade})`;

  // Apostrophes would close the quoted value, so swap in a typographic one.
  // The trailing space stops slanted fonts (Bangers) clipping their last letter.
  const text = tx.text.replace(/'/g, '’').replace(/\\/g, '').replace(/\n/g, ' ');

  return `drawtext=fontfile='${escapeFontPath(fontPath)}':expansion=none:text='${text} '` +
    `:fontsize='${size}':fontcolor=white:borderw=${Math.max(1, Math.round(S / 16))}:bordercolor=black` +
    `:x=${f(tx.x)}-tw/2+th*0.12:y=${f(tx.y)}-th/2:alpha='${alpha}'` +
    `:enable='between(t\\,${T}\\,${f(T + D)})'`;
}

export function buildFilter(fontPath) {
  const segs = buildSegments();
  const lines = [];

  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    const range = last ? `start=${f(s.start)}` : `start=${f(s.start)}:end=${f(s.end)}`;
    const pts = s.rate === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${s.rate}`;
    lines.push(`[0:v]trim=${range},setpts=${pts}[v${i}]`);
    lines.push(`[0:a]atrim=${range},asetpts=PTS-STARTPTS${atempo(s.rate)}[a${i}]`);
  });

  const ins = segs.map((_, i) => `[v${i}][a${i}]`).join('');
  lines.push(`${ins}concat=n=${segs.length}:v=1:a=1[cv][a]`);

  const topH = even(slotH('A'));
  lines.push('[cv]fps=30,split[sa][sb]');
  lines.push(`[sa]${cropFor('A')},scale=${OUT_W}:${topH},setsar=1[top]`);
  lines.push(`[sb]${cropFor('B')},scale=${OUT_W}:${OUT_H - topH},setsar=1[bot]`);

  const texts = [...state.texts].sort((a, b) => a.start - b.start);
  const chain = texts.map((t) => drawtext(t, fontPath));
  lines.push(`[top][bot]vstack${chain.length ? ',' + chain.join(',') : ''}[v]`);

  return lines.join(';\n') + '\n';
}

export function buildCommand(filterFile = 'filter.txt') {
  const out = `${state.fileName.replace(/\.[^.]+$/, '')}_vertical.mp4`;
  return `ffmpeg -y -i "${state.fileName}" -/filter_complex ${filterFile} -map "[v]" -map "[a]" ` +
    `-c:v libx264 -preset slow -crf 18 -c:a aac -b:a 160k -movflags +faststart "${out}"`;
}
