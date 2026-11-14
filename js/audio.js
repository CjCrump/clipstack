// Routes the video's audio through Web Audio so the browser export can record it.
// A media element can only be connected once, so this is created lazily and reused.
// Must first run from a click (browsers block audio until the user interacts).

let ctx = null;
let dest = null;

export function ensureAudio(video) {
  if (!ctx) {
    ctx = new AudioContext();
    const src = ctx.createMediaElementSource(video);
    dest = ctx.createMediaStreamDestination();
    src.connect(ctx.destination); // speakers
    src.connect(dest); // recorder
  }
  if (ctx.state === 'suspended') ctx.resume();
  return { ctx, dest };
}
