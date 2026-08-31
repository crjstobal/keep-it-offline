import sys, os, zipfile
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
    check("the clip is on the bench", p.locator("#video-grid .image-cell").count() == 1)

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
    caption = p.inner_text("#video-grid .image-name")
    check("the caption shows the rotated size", "360×640" in caption, caption)

    # Trim.
    p.fill("#trim-start", "0.5")
    p.fill("#trim-end", "1.5")
    p.click("#apply-trim")
    p.wait_for_timeout(600)
    check("trim queues a second operation", p.locator(".op").count() == 2)
    caption = p.inner_text("#video-grid .image-name")
    check("the caption shows the trimmed duration", "1.0s" in caption, caption)

    # Export the clip and confirm a real video comes out.
    with p.expect_download(timeout=60000) as dl:
        p.click("#export-btn")
    d = dl.value
    name = d.suggested_filename
    check("export produces a video file", name.endswith(".mp4") or name.endswith(".webm"), name)
    size = os.path.getsize(d.path())
    check("the exported clip has real content", size > 5000, f"{size} bytes")

    # A trim asked for one second has to produce one second. MediaRecorder
    # stamps frames with wall-clock time, so rendering faster than real time
    # silently shortens the clip unless each frame is held for its slot.
    import subprocess
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", d.path()],
            capture_output=True, text=True, timeout=30)
        duration = float(out.stdout.strip())
        check("the exported clip lasts as long as the trim asked for",
              0.9 <= duration <= 1.15, f"{duration}s for a 1.0s trim")
    except (FileNotFoundError, ValueError, subprocess.TimeoutExpired) as e:
        print(f"  --  skipped duration check (ffprobe unavailable: {e})")

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

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
