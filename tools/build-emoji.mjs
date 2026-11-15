// Rebuilds vendor/noto-emoji/ from upstream sources. Not part of the site; run by hand
// when Noto or Unicode adds emoji.
//
//   1. git clone --depth 1 --filter=blob:none --sparse https://github.com/googlefonts/noto-emoji /tmp/noto
//      git -C /tmp/noto sparse-checkout set 2D/svg
//   2. npm i --no-save emojibase-data svgo      (in any scratch folder)
//   3. node tools/build-emoji.mjs /tmp/noto/2D/svg <scratch>/node_modules
//
// Output: vendor/noto-emoji/svg/*.svg (minified), vendor/noto-emoji/index.json, licenses.
// Flags and skin-tone "component" swatches are left out. Couple emoji with two
// different skin tones are left out; matching tones are kept.

import { readFile, writeFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [SVG_DIR, NODE_MODULES] = process.argv.slice(2);
if (!SVG_DIR || !NODE_MODULES) throw new Error('usage: node tools/build-emoji.mjs <noto 2D/svg dir> <node_modules dir>');
const require = createRequire(join(NODE_MODULES, 'x.js'));
const data = require('emojibase-data/en/data.json');
const { optimize } = require('svgo');

const OUT = 'vendor/noto-emoji';
const SKIP_GROUPS = new Set([2, 9]); // component, flags
// Picker tabs, in emojibase group order (2 and 9 skipped)
const GROUPS = { 0: 'Smileys', 1: 'People', 3: 'Animals & nature', 4: 'Food & drink', 5: 'Travel & places', 6: 'Activities', 7: 'Objects', 8: 'Symbols' };

// Noto names files emoji_u<hex>_<hex>.svg, lowercase, with every FE0F removed
const notoName = (hex) => 'emoji_u' + hex.toLowerCase().split('-').filter((h) => h !== 'fe0f').join('_') + '.svg';
// Our served name drops the prefix to keep URLs and the index short
const outName = (hex) => hex.toLowerCase().split('-').filter((h) => h !== 'fe0f').join('_');

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'svg'), { recursive: true });

let copied = 0, missing = 0, bytesIn = 0, bytesOut = 0;
async function take(hex) {
  const src = join(SVG_DIR, notoName(hex));
  if (!existsSync(src)) { missing++; return null; }
  const raw = await readFile(src, 'utf8');
  // svgo 4 keeps viewBox by default, so emoji still scale cleanly
  let min = optimize(raw, { multipass: true, plugins: ['preset-default'] }).data;
  // Firefox won't draw an SVG onto a canvas unless it has a width and height
  min = min.replace(/^<svg([^>]*)>/, (tag, attrs) => {
    if (/\swidth=/.test(attrs)) return tag;
    const vb = attrs.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
    return vb ? `<svg width="${vb[1]}" height="${vb[2]}"${attrs}>` : tag;
  });
  const name = outName(hex);
  await writeFile(join(OUT, 'svg', name + '.svg'), min);
  bytesIn += raw.length; bytesOut += min.length; copied++;
  return name;
}

// index entry: [file, label, keywords, group, tones?]  tones = 5 files, light to dark
const index = [];
for (const e of data.sort((a, b) => a.order - b.order)) {
  if (SKIP_GROUPS.has(e.group) || e.group === undefined) continue;
  const file = await take(e.hexcode);
  if (!file) continue;
  const entry = [file, e.label, (e.tags || []).join(' '), e.group];
  if (e.skins) {
    const byTone = {};
    for (const s of e.skins) {
      const t = Array.isArray(s.tone) ? (s.tone.every((x) => x === s.tone[0]) ? s.tone[0] : null) : s.tone;
      if (t && !byTone[t]) byTone[t] = s.hexcode;
    }
    const tones = [];
    for (let t = 1; t <= 5; t++) tones.push(byTone[t] ? await take(byTone[t]) : null);
    if (tones.every(Boolean)) entry.push(tones);
  }
  index.push(entry);
}

await writeFile(join(OUT, 'index.json'), JSON.stringify({ groups: GROUPS, emoji: index }));
await copyFile(join(SVG_DIR, 'LICENSE'), join(OUT, 'LICENSE-noto-apache-2.0.txt'));
await copyFile(join(NODE_MODULES, 'emojibase-data', 'LICENSE'), join(OUT, 'LICENSE-emojibase-mit.txt'));
await writeFile(join(OUT, 'README.md'), [
  '# Emoji assets',
  '',
  '- `svg/`: Google Noto Color Emoji SVGs (https://github.com/googlefonts/noto-emoji, 2D/svg),',
  '  Apache License 2.0, minified with svgo. File names are the codepoints in hex, joined by `_`.',
  '- `index.json`: names, keywords, groups and skin tones from emojibase-data',
  '  (https://github.com/milesj/emojibase, MIT), built on Unicode and CLDR data.',
  '- Rebuild with `tools/build-emoji.mjs`.',
  '',
].join('\n'));

console.log(`${index.length} picker entries, ${copied} SVGs (${missing} not in Noto)`);
console.log(`SVG size ${(bytesIn / 1048576).toFixed(1)} MB -> ${(bytesOut / 1048576).toFixed(1)} MB`);
