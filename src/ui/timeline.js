// A scrubbable timeline with draggable trim handles, shared by audio and video.
//
// Typing numbers into two boxes is no way to choose a cut: you have to hear or
// see where it lands. This gives a play head, handles you drag, and a zoom, so a
// trim can be aimed rather than guessed.

/**
 * @param {Object} options
 * @param {HTMLElement} options.container
 * @param {number} options.duration       Seconds.
 * @param {() => number[]} [options.peaks] Waveform data, if there is any.
 * @param {(start: number, end: number) => void} options.onChange
 * @param {(time: number) => void} [options.onScrub]
 */
export function createTimeline({ container, duration, peaks, onChange, onScrub }) {
  let start = 0;
  let end = duration;
  let playhead = 0;
  // Zoom is a window onto the timeline: [viewStart, viewEnd] in seconds.
  let viewStart = 0;
  let viewEnd = duration;

  container.replaceChildren();
  container.classList.add('timeline');

  const canvas = document.createElement('canvas');
  canvas.className = 'timeline-canvas';
  container.append(canvas);

  const selection = document.createElement('div');
  selection.className = 'timeline-selection';
  container.append(selection);

  const handleStart = document.createElement('div');
  handleStart.className = 'timeline-handle timeline-handle-start';
  handleStart.setAttribute('role', 'slider');
  handleStart.setAttribute('aria-label', 'Trim start');
  handleStart.tabIndex = 0;

  const handleEnd = document.createElement('div');
  handleEnd.className = 'timeline-handle timeline-handle-end';
  handleEnd.setAttribute('role', 'slider');
  handleEnd.setAttribute('aria-label', 'Trim end');
  handleEnd.tabIndex = 0;

  const head = document.createElement('div');
  head.className = 'timeline-playhead';

  container.append(selection, handleStart, handleEnd, head);

  const viewSpan = () => Math.max(0.01, viewEnd - viewStart);
  const timeToRatio = (time) => (time - viewStart) / viewSpan();
  const ratioToTime = (ratio) => viewStart + ratio * viewSpan();

  function ratioFromEvent(event) {
    const rect = container.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  /** Canvas cannot read CSS variables, so the palette is fetched once per draw. */
  function palette() {
    const style = getComputedStyle(container);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      inRange: read('--accent', '#f26a2e'),
      outOfRange: read('--line', '#e6e0d4'),
      track: read('--panel-2', '#faf7f1'),
      ticks: read('--muted', '#8d887c'),
    };
  }

  function draw() {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;

    const colours = palette();

    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const data = peaks?.();
    if (data && data.length) {
      // Only the visible window is drawn, which is what makes zooming useful:
      // the same pixels cover less time, so quiet detail becomes visible.
      const firstPeak = Math.floor((viewStart / duration) * data.length);
      const lastPeak = Math.ceil((viewEnd / duration) * data.length);
      const visible = data.slice(firstPeak, Math.max(firstPeak + 1, lastPeak));
      const barWidth = rect.width / visible.length;

      for (const [index, peak] of visible.entries()) {
        const x = index * barWidth;
        const time = ratioToTime(x / rect.width);
        const inRange = time >= start && time <= end;
        const barHeight = Math.max(1, peak * rect.height * 0.86);
        context.fillStyle = inRange ? colours.inRange : colours.outOfRange;
        context.fillRect(x, (rect.height - barHeight) / 2, Math.max(1, barWidth - 0.5), barHeight);
      }
    } else {
      // No waveform (video): a plain track still shows the selection.
      context.fillStyle = colours.track;
      context.fillRect(0, 0, rect.width, rect.height);
    }

    // Second markers, as many as fit without crowding.
    context.fillStyle = colours.ticks;
    context.font = '10px ui-monospace, monospace';
    const step = niceStep(viewSpan(), rect.width);
    for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd; t += step) {
      const x = timeToRatio(t) * rect.width;
      context.fillRect(x, rect.height - 8, 1, 8);
      context.fillText(formatTime(t), x + 3, rect.height - 10);
    }

    positionOverlays(rect.width);
  }

  function positionOverlays(width) {
    const startX = Math.max(0, timeToRatio(start)) * width;
    const endX = Math.min(1, timeToRatio(end)) * width;
    selection.style.left = `${startX}px`;
    selection.style.width = `${Math.max(0, endX - startX)}px`;
    handleStart.style.left = `${startX}px`;
    handleEnd.style.left = `${endX}px`;
    handleStart.hidden = timeToRatio(start) < -0.02;
    handleEnd.hidden = timeToRatio(end) > 1.02;
    head.style.left = `${Math.min(1, Math.max(0, timeToRatio(playhead))) * width}px`;
    head.hidden = playhead < viewStart || playhead > viewEnd;
  }

  // Dragging a handle, or scrubbing on the track itself.
  let dragging = null;

  const moveHandle = (event) => {
    if (!dragging) return;
    const time = Math.min(duration, Math.max(0, ratioToTime(ratioFromEvent(event))));

    // Handles cannot cross, and a selection shorter than a tenth of a second is
    // not a cut anyone meant to make.
    if (dragging === 'start') start = Math.min(time, end - 0.1);
    else end = Math.max(time, start + 0.1);

    draw();
    onChange(start, end);
  };

  const endDrag = () => {
    dragging = null;
    window.removeEventListener('pointermove', moveHandle);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  };

  // The listeners go on the window rather than the handle: a drag routinely
  // leaves the twelve-pixel handle behind, and the pointer has to keep being
  // followed until it is released anywhere on the page.
  const startDrag = (which) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragging = which;
    window.addEventListener('pointermove', moveHandle);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  handleStart.addEventListener('pointerdown', startDrag('start'));
  handleEnd.addEventListener('pointerdown', startDrag('end'));

  container.addEventListener('pointerdown', (event) => {
    if (dragging || event.target === handleStart || event.target === handleEnd) return;
    // A click on the track moves the play head there.
    playhead = ratioToTime(ratioFromEvent(event));
    onScrub?.(playhead);
    draw();
  });

  // Keyboard nudges, so the handles are not mouse-only.
  for (const [handle, which] of [[handleStart, 'start'], [handleEnd, 'end']]) {
    handle.addEventListener('keydown', (event) => {
      const step = event.shiftKey ? 1 : 0.1;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -step : step;
        if (which === 'start') start = Math.min(Math.max(0, start + delta), end - 0.1);
        else end = Math.max(Math.min(duration, end + delta), start + 0.1);
        draw();
        onChange(start, end);
      }
    });
  }

  // Scroll to zoom, anchored on the pointer so the moment under it stays put.
  container.addEventListener(
    'wheel',
    (event) => {
      if (viewSpan() >= duration && event.deltaY > 0) return;
      event.preventDefault();

      const anchor = ratioToTime(ratioFromEvent(event));
      const factor = event.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.min(duration, Math.max(0.5, viewSpan() * factor));
      const ratio = (anchor - viewStart) / viewSpan();

      viewStart = Math.max(0, Math.min(duration - span, anchor - ratio * span));
      viewEnd = viewStart + span;
      draw();
    },
    { passive: false },
  );

  const observer = new ResizeObserver(() => draw());
  observer.observe(container);
  draw();

  return {
    setPlayhead(time) {
      playhead = time;
      const rect = container.getBoundingClientRect();
      if (rect.width) positionOverlays(rect.width);
    },
    setRange(newStart, newEnd) {
      start = newStart;
      end = newEnd;
      draw();
    },
    getRange: () => ({ start, end }),
    resetZoom() {
      viewStart = 0;
      viewEnd = duration;
      draw();
    },
    redraw: draw,
    destroy() {
      endDrag();
      observer.disconnect();
    },
  };
}

/** A tick spacing that leaves labels readable at the current width. */
function niceStep(span, width) {
  const target = span / Math.max(2, Math.floor(width / 70));
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((step) => step >= target) ?? 900;
}

function formatTime(seconds) {
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
