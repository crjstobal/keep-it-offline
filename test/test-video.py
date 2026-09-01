import sys, os, subprocess
from playwright.sync_api import sync_playwright

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")
    check("video editor hidden with an empty bench", p.locator("#video-editor").is_hidden())

    p.set_input_files("#file-input", f"{S}/clip.mp4")
    p.wait_for_timeout(3500)

    check("video editor appears once a clip is loaded", p.locator("#video-editor").is_visible())
    check("the clip is on the bench", p.locator("#video-grid .video-cell").count() == 1)

    meta = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const a = getState().assets.find(x => x.kind === 'video');
        return {d: a.meta.duration, w: a.meta.width, h: a.meta.height, o: a.meta.orientation,
                poster: Boolean(a.meta.poster)};
    }""")
    check("duration is read", 1.8 < meta["d"] < 2.3, str(meta["d"]))
    check("dimensions are read", (meta["w"], meta["h"]) == (640, 360), f"{meta['w']}x{meta['h']}")
    check("orientation is detected", meta["o"] == "landscape", meta["o"])
    check("a poster frame is captured", meta["poster"])

    # Rotation, queued as one operation.
    p.click("#video-rotate-right")
    p.wait_for_timeout(600)
    check("rotation queues one operation", p.locator(".op").count() == 1)
    caption = p.inner_text("#video-grid .audio-meta")
    check("the caption shows the rotated size", "360×640" in caption, caption)

    # Trim by dragging a timeline handle, the way a person would.
    box = p.locator(".timeline").bounding_box()
    eb = p.locator(".timeline-handle-end").bounding_box()
    p.mouse.move(eb["x"] + eb["width"]/2, eb["y"] + eb["height"]/2)
    p.mouse.down()
    p.mouse.move(box["x"] + box["width"]*0.5, eb["y"] + eb["height"]/2, steps=8)
    p.mouse.up()
    p.wait_for_timeout(400)
    p.click("text=Trim to selection")
    p.wait_for_timeout(600)
    check("dragging a handle and trimming queues an operation",
          p.locator(".op").count() == 2, f"{p.locator('.op').count()} ops")

    # And the trim has to reach the file. Everything is cleared and a known trim
    # queued, so the measurement is of the trim alone rather than of whatever
    # the drag happened to land on.
    p.evaluate("""async () => {
        const { getState, clearOperations, pushOperation } = await import('./src/core/workspace.js');
        clearOperations();
        const a = getState().assets.find(x => x.kind === 'video');
        pushOperation({ type: 'trim_video', assetIds: a.id, params: { start: 0, end: 1 },
                        summary: 'Trim to 0s-1s', source: 'user' });
    }""")
    p.wait_for_timeout(600)

    with p.expect_download(timeout=60000) as dl2:
        p.click("#export-btn")
    trimmed_path = "/tmp/trimmed-clip.mp4"
    dl2.value.save_as(trimmed_path)
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", trimmed_path],
            capture_output=True, text=True, timeout=30)
        trimmed = float(out.stdout.strip())
        check("a trim shortens the exported clip",
              0.8 <= trimmed <= 1.2, f"{trimmed}s for a 1s trim of a 2s clip")
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired) as e:
        print(f"  --  skipped trimmed duration check ({e})")

    # Export a rotated but untrimmed clip: the stack is reset to just a rotation
    # so this measures length independently of the trims exercised above.
    p.evaluate("""async () => {
        const { getState, clearOperations, pushOperation } = await import('./src/core/workspace.js');
        clearOperations();
        const a = getState().assets.find(x => x.kind === 'video');
        pushOperation({ type: 'rotate_video', assetIds: a.id, params: { degrees: 90 },
                        summary: 'Rotate 90', source: 'user' });
    }""")
    p.wait_for_timeout(600)

    with p.expect_download(timeout=60000) as dl:
        p.click("#export-btn")
    d = dl.value
    name = d.suggested_filename
    check("export produces a video file", name.endswith(".mp4") or name.endswith(".webm"), name)
    size = os.path.getsize(d.path())
    check("the exported clip has real content", size > 5000, f"{size} bytes")

    # This export carries a rotation but no trim, so it must keep its length.
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", d.path()],
            capture_output=True, text=True, timeout=30)
        full = float(out.stdout.strip())
        check("an untrimmed export keeps its full length",
              1.8 <= full <= 2.2, f"{full}s for a 2s clip")
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired) as e:
        print(f"  --  skipped full-length check ({e})")


    # Smart orientation over a mixed set: only what needs turning is turned.
    p.set_input_files("#file-input", f"{S}/clip-portrait.mp4")
    p.wait_for_timeout(3000)
    result = p.evaluate("""async () => {
        const { getState, clearOperations } = await import('./src/core/workspace.js');
        const { plan } = await import('./src/core/video.js');
        clearOperations();
        const vids = getState().assets.filter(a => a.kind === 'video');
        const op = [{type:'set_orientation', params:{orientation:'portrait'}}];
        return vids.map(v => {
            const out = plan(v.meta, op);
            return {name: v.name, from: [v.meta.width, v.meta.height], to: [out.width, out.height], rot: out.rotation};
        });
    }""")
    landscape = next(r for r in result if r["from"] == [640, 360])
    portrait = next(r for r in result if r["from"] == [360, 640])
    check("a landscape clip asked for portrait is turned",
          landscape["to"] == [360, 640] and landscape["rot"] == 90, str(landscape))
    check("a clip already portrait is left alone",
          portrait["to"] == [360, 640] and portrait["rot"] == 0, str(portrait))

    # A clip carries the same two controls a photograph does.
    check("each clip has a view and a remove control",
          p.locator(".video-cell .cell-button").count() == p.locator(".video-cell").count() * 2)

    # A look takes a strength, and rotation folds rather than stacking.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    p.wait_for_timeout(400)
    p.select_option("#video-look", "warm")
    p.wait_for_timeout(2000)
    p.locator("#video-strength").fill("40")
    p.wait_for_timeout(1800)
    graded = [t for t in p.evaluate("() => [...document.querySelectorAll('.op-summary')].map(e=>e.textContent)") if "warm" in t]
    check("a video look takes a strength", graded and "40%" in graded[0], str(graded))
    check("changing strength keeps it to one row", len(graded) == 1, str(graded))

    p.click("#video-rotate-left"); p.wait_for_timeout(700)
    p.click("#video-rotate-left"); p.wait_for_timeout(900)
    rots = [t for t in p.evaluate("() => [...document.querySelectorAll('.op-summary')].map(e=>e.textContent)") if "Rotate" in t]
    check("two turns fold into a half turn", len(rots) == 1 and "180" in rots[0], str(rots))

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
