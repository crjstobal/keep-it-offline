// Sample files, so the bench is never empty for someone trying it for the first
// time.
//
// A workbench with nothing on it cannot demonstrate anything, and asking a
// visitor to go and find a PDF before they can see what this does loses most of
// them. Each set is chosen to have something wrong with it worth fixing: pages
// that are blank, photographs that are sideways, junk at both ends of a
// recording.

const SETS = [
  {
    id: 'pdf',
    label: 'A report',
    detail: '12 pages, some blank, two sideways, one full of personal data',
    icon: fileIcon,
    files: [{ path: 'sample-report.pdf', type: 'application/pdf' }],
  },
  {
    id: 'photos',
    label: 'Photographs',
    detail: '5 shots, mixed orientations, a few of them turned the wrong way',
    icon: imageIcon,
    files: [
      { path: 'photo-market.jpg', type: 'image/jpeg' },
      { path: 'photo-harbour.jpg', type: 'image/jpeg' },
      { path: 'photo-cafe.jpg', type: 'image/jpeg' },
      { path: 'photo-street.jpg', type: 'image/jpeg' },
      { path: 'photo-desk.jpg', type: 'image/jpeg' },
    ],
  },
  {
    id: 'video',
    label: 'A video clip',
    detail: 'Something to trim, turn and grade',
    icon: videoIcon,
    files: [{ path: 'sample-clip.mp4', type: 'video/mp4' }],
  },
  {
    id: 'audio',
    label: 'A recording',
    detail: '32 seconds, with noise at both ends worth cutting off',
    icon: audioIcon,
    files: [{ path: 'sample-voice.mp3', type: 'audio/mpeg' }],
  },
];

/**
 * @param {Object} options
 * @param {(files: File[]) => Promise<void>} options.onLoad
 */
export function init({ onLoad }) {
  const button = document.createElement('button');
  button.className = 'demo-button';
  button.type = 'button';
  button.innerHTML = `${sparkIcon()}<span>Try it with sample files</span>`;

  const menu = document.createElement('div');
  menu.className = 'demo-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');

  const heading = document.createElement('p');
  heading.className = 'demo-menu-heading';
  heading.textContent = 'Load something to work on';
  menu.append(heading);

  for (const set of SETS) {
    const item = document.createElement('button');
    item.className = 'demo-item';
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.innerHTML =
      `<span class="demo-item-icon">${set.icon()}</span>` +
      `<span class="demo-item-text"><b>${set.label}</b><small>${set.detail}</small></span>`;

    item.addEventListener('click', async () => {
      item.disabled = true;
      item.classList.add('is-loading');
      try {
        await load(set, onLoad);
        close();
      } catch (error) {
        console.error('[keepitoffline] could not load the sample files', error);
        item.classList.add('is-failed');
      } finally {
        item.disabled = false;
        item.classList.remove('is-loading');
      }
    });
    menu.append(item);
  }

  const note = document.createElement('p');
  note.className = 'demo-menu-note';
  note.textContent = 'Samples are fetched from this site, then stay in the tab like any other file.';
  menu.append(note);

  const wrap = document.createElement('div');
  wrap.className = 'demo-launcher';
  wrap.append(menu, button);
  document.body.append(wrap);

  const open = () => {
    menu.hidden = false;
    button.classList.add('is-open');
    document.addEventListener('click', onOutside, true);
    document.addEventListener('keydown', onEscape);
  };
  const close = () => {
    menu.hidden = true;
    button.classList.remove('is-open');
    document.removeEventListener('click', onOutside, true);
    document.removeEventListener('keydown', onEscape);
  };
  function onOutside(event) {
    if (!wrap.contains(event.target)) close();
  }
  function onEscape(event) {
    if (event.key === 'Escape') close();
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
}

async function load(set, onLoad) {
  const files = [];
  for (const spec of set.files) {
    const url = new URL(`../../demo-assets/${spec.path}`, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not fetch ${spec.path}: ${response.status}`);
    const blob = await response.blob();
    files.push(new File([blob], spec.path, { type: spec.type }));
  }
  await onLoad(files);
}

// Icons are inline SVG rather than a font or a package: four small paths are
// not worth a dependency, and they inherit colour for free.
function sparkIcon() {
  return (
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3v3M12 18v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M3 12h3M18 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>' +
    '<circle cx="12" cy="12" r="3.2"/></svg>'
  );
}

function fileIcon() {
  return (
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>'
  );
}

function imageIcon() {
  return (
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/>' +
    '<path d="m21 15-4.5-4.5L7 20"/></svg>'
  );
}

function videoIcon() {
  return (
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m16 10 4.5-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L16 14"/>' +
    '<rect x="2" y="6" width="14" height="12" rx="2"/></svg>'
  );
}

function audioIcon() {
  return (
    '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>'
  );
}
