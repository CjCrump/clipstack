// Speeds audio up without raising the pitch (no chipmunk voices), using WSOLA:
// "waveform similarity overlap-add". It cuts the input into short overlapping
// windows, skips ahead through the input faster than it writes the output, and
// picks each window's exact start so its waveform lines up with the last one.

const N = 2048; // window length in samples (~43 ms at 48 kHz)
const HS = N / 2; // output hop: windows overlap by half
const TOL = 512; // how far each window may shift to find the best match
const STEP = 4; // correlate every 4th sample; plenty accurate, 4x faster

// Periodic Hann window: two copies offset by half a window add up to exactly 1.
const WINDOW = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));

/**
 * @param {Float32Array[]} channels input audio, one array per channel
 * @param {number} rate speed factor, e.g. 4 = four times faster
 * @returns {Float32Array[]} stretched audio, about length / rate samples per channel
 */
export function timeStretch(channels, rate) {
  const len = channels[0].length;
  const outLen = Math.floor(len / rate);
  if (rate === 1 || len < N * 2) return channels.map((c) => c.slice(0, outLen));

  const out = channels.map(() => new Float32Array(outLen + N));
  const mono = mixDown(channels);
  const maxPos = len - N;
  const ha = HS * rate; // input hop

  let prev = 0;
  for (let k = 0, outPos = 0; outPos < outLen; k++, outPos += HS) {
    const nominal = Math.min(maxPos, Math.round(k * ha));
    const pos = k === 0 ? 0 : bestMatch(mono, prev + HS, nominal, maxPos);
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < N; i++) dst[outPos + i] += src[pos + i] * WINDOW[i];
    }
    prev = pos;
  }
  return out.map((c) => c.subarray(0, outLen));
}

// Find the start near `nominal` whose first half-window best matches the audio
// that would naturally follow the previous window (starting at `target`).
function bestMatch(mono, target, nominal, maxPos) {
  if (target > maxPos) return nominal;
  const lo = Math.max(0, nominal - TOL);
  const hi = Math.min(maxPos, nominal + TOL);
  let best = nominal;
  let bestScore = -Infinity;
  for (let p = lo; p <= hi; p += 2) {
    let score = 0;
    for (let i = 0; i < HS; i += STEP) score += mono[p + i] * mono[target + i];
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

function mixDown(channels) {
  if (channels.length === 1) return channels[0];
  const m = new Float32Array(channels[0].length);
  for (const c of channels) for (let i = 0; i < m.length; i++) m[i] += c[i];
  return m;
}
