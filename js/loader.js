// Loading a clip: file picker, drag-and-drop, and plain-English errors when
// the browser can't play a file. The file is never uploaded; the browser reads
// it straight from disk through an object URL.

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ts|flv)$/i;
const LONG_CLIP_SECS = 15 * 60;

let video, onNotice, currentUrl = null, currentName = '';

/**
 * @param {object} opts
 * @param {HTMLVideoElement} opts.video
 * @param {HTMLInputElement} opts.input hidden file input
 * @param {HTMLElement} opts.dropZone element that accepts dropped files
 * @param {(file: File) => void} opts.onFile called when a file starts loading
 * @param {(message: string|null, kind?: 'error'|'info') => void} opts.notice
 */
export function initLoader({ video: v, input, dropZone, onFile, notice }) {
  video = v;
  onNotice = notice;

  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = ''; // lets the same file be picked again
    if (file) load(file, onFile);
  });

  dropZone.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dropZone.classList.add('dragging');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file) load(file, onFile);
  });

  video.addEventListener('error', () => onNotice(explainError(video.error), 'error'));
  video.addEventListener('loadedmetadata', () => {
    if (!video.videoWidth) {
      onNotice(`"${currentName}" has no video picture (audio only?). Pick a video file.`, 'error');
    } else if (video.duration > LONG_CLIP_SECS) {
      onNotice('This clip is over 15 minutes. Editing works, but exporting in the browser may run out of memory. Trim it first, or use the ffmpeg command.', 'info');
    }
  });
}

function load(file, onFile) {
  if (!file.type.startsWith('video/') && !VIDEO_EXT.test(file.name)) {
    onNotice(`"${file.name}" isn't a video file.`, 'error');
    return;
  }
  onNotice(null);
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(file);
  currentName = file.name;
  onFile(file);
  video.src = currentUrl;
}

function explainError(err) {
  const name = currentName;
  const unsupported = err && (err.code === err.MEDIA_ERR_SRC_NOT_SUPPORTED || err.code === err.MEDIA_ERR_DECODE);
  if (!unsupported) return `Couldn't read "${name}". The file may be damaged or still being written.`;
  if (/\.mkv$/i.test(name)) {
    return `Browsers often can't play MKV files like "${name}". In OBS, use File > Remux Recordings to turn it into an MP4. It takes seconds and doesn't lose quality.`;
  }
  return `This browser can't play the video format in "${name}". It's usually HEVC (H.265) or AV1. ` +
    'Convert it to H.264 MP4, or in OBS set Settings > Output > Recording > Video Encoder to an H.264 option for future clips.';
}

// True if this browser can do the in-browser MP4 export.
export const canExportInBrowser = () => typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
