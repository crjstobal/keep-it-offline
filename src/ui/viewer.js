// The enlarged view, shared by PDF pages and images. A thumbnail is enough to
// pick something out, never enough to judge it, so both grids need this.
//
// Callers describe their own sequence: how many items, what each is called, and
// how to get a full-size source for one. That keeps the viewer from knowing
// anything about PDFs or LUTs.

let dom = null;
let session = null;

function build() {
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.hidden = true;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Enlarged view');

  const img = document.createElement('img');
  img.className = 'viewer-image';

  const caption = document.createElement('div');
  caption.className = 'viewer-caption';

  const close = document.createElement('button');
  close.className = 'viewer-close';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeViewer);

  // True fullscreen, not just a large overlay: judging a photograph means
  // seeing it without the rest of the interface competing for attention.
  const expand = document.createElement('button');
  expand.className = 'viewer-expand';
  expand.setAttribute('aria-label', 'Toggle fullscreen');
  expand.title = 'Fullscreen (F)';
  expand.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  expand.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFullscreen();
  });

  const prev = document.createElement('button');
  prev.className = 'viewer-nav viewer-prev';
  prev.textContent = '‹';
  prev.setAttribute('aria-label', 'Previous');
  prev.addEventListener('click', (event) => {
    event.stopPropagation();
    step(-1);
  });

  const next = document.createElement('button');
  next.className = 'viewer-nav viewer-next';
  next.textContent = '›';
  next.setAttribute('aria-label', 'Next');
  next.addEventListener('click', (event) => {
    event.stopPropagation();
    step(1);
  });

  // Clicking the backdrop closes, but clicking the item itself does not.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeViewer();
  });
  img.addEventListener('click', (event) => event.stopPropagation());

  overlay.append(close, expand, prev, img, next, caption);
  document.body.append(overlay);
  return { overlay, img, caption, prev, next };
}

/**
 * @param {Object} options
 * @param {number} options.index                 Where to start.
 * @param {number} options.total                 How many items in the sequence.
 * @param {(i: number) => string} options.caption
 * @param {(i: number) => Promise<string>} options.resolve  Full-size source.
 * @param {(i: number) => number} [options.rotation]        Degrees, if any.
 * @param {(i: number) => string} [options.placeholder]     Shown while resolving.
 */
export function openViewer(options) {
  if (!dom) dom = build();
  session = options;

  const single = options.total <= 1;
  dom.prev.hidden = single;
  dom.next.hidden = single;

  show(options.index);
  dom.overlay.hidden = false;
  document.addEventListener('keydown', onKey);
}

export function closeViewer() {
  if (!dom) return;
  dom.overlay.hidden = true;
  session = null;
  document.removeEventListener('keydown', onKey);
}

export function isViewerOpen() {
  return Boolean(dom && !dom.overlay.hidden);
}

function step(delta) {
  if (!session) return;
  session.index = (session.index + delta + session.total) % session.total;
  show(session.index);
}

async function show(index) {
  if (!dom || !session) return;
  const current = session;

  dom.caption.textContent = current.caption(index);

  const rotation = current.rotation?.(index) ?? 0;
  dom.img.style.rotate = `${rotation}deg`;
  dom.img.classList.toggle('is-quarter-turned', rotation === 90 || rotation === 270);

  const placeholder = current.placeholder?.(index);
  if (placeholder) dom.img.src = placeholder;

  try {
    const src = await current.resolve(index);
    // The user may have moved on, or closed the viewer, while that resolved.
    if (session === current && current.index === index && src) dom.img.src = src;
  } catch (error) {
    console.error('[keepitoffline] could not load the enlarged view', error);
  }
}

export async function toggleFullscreen() {
  if (!dom) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await dom.overlay.requestFullscreen();
  } catch (error) {
    // Fullscreen can be refused by policy or by the user; the overlay still
    // works, so this is not worth interrupting anyone over.
    console.warn('[keepitoffline] fullscreen unavailable', error);
  }
}

function onKey(event) {
  // Escape leaves fullscreen on its own before it would close the viewer.
  if (event.key === 'Escape' && !document.fullscreenElement) closeViewer();
  else if (event.key === 'ArrowRight') step(1);
  else if (event.key === 'ArrowLeft') step(-1);
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
}
