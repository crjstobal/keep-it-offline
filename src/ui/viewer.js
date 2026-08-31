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

  overlay.append(close, prev, img, next, caption);
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

function onKey(event) {
  if (event.key === 'Escape') closeViewer();
  else if (event.key === 'ArrowRight') step(1);
  else if (event.key === 'ArrowLeft') step(-1);
}
