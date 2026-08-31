import sys, os, subprocess, wave
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
    check("audio editor hidden with an empty bench", p.locator("#audio-editor").is_hidden())

    p.set_input_files("#file-input", f"{S}/tone.mp3")
    p.wait_for_timeout(3000)

    check("audio editor appears once a track is loaded", p.locator("#audio-editor").is_visible())
    check("the track is listed", p.locator(".audio-row").count() == 1)

    meta = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const a = getState().assets.find(x => x.kind === 'audio');
        return {d: a.meta.duration, sr: a.meta.sampleRate, ch: a.meta.channels,
                peaks: (a.meta.peaks || []).length};
    }""")
    check("duration is read", 3.8 < meta["d"] < 4.3, str(meta["d"]))
    check("a waveform is computed", meta["peaks"] > 100, str(meta["peaks"]))

    # Speed: a faster clip must be proportionally shorter.
    p.locator("#audio-speed").fill("200")
    p.wait_for_timeout(300)
    check("the speed label follows the slider", "2.00" in p.inner_text("#audio-speed-value"),
          p.inner_text("#audio-speed-value"))
    p.click("#apply-speed")
    p.wait_for_timeout(800)
    check("speed queues one operation", p.locator(".op").count() == 1)
    shown = p.inner_text(".audio-meta")
    check("the row shows the new duration", "2.0s" in shown, shown)

    with p.expect_download(timeout=45000) as dl:
        p.click("#export-btn")
    out = "/tmp/audio-out.wav"
    dl.value.save_as(out)
    check("export produces a wav", dl.value.suggested_filename.endswith(".wav"),
          dl.value.suggested_filename)

    with wave.open(out) as w:
        frames, rate = w.getnframes(), w.getframerate()
        duration = frames / rate
    check("the exported audio is half as long at 2x",
          1.8 < duration < 2.2, f"{duration:.2f}s")
    check("the export is real PCM audio", frames > 1000, f"{frames} frames")

    # Trim on top of the speed change.
    p.fill("#audio-trim-start", "1")
    p.fill("#audio-trim-end", "3")
    p.click("#apply-audio-trim")
    p.wait_for_timeout(800)
    check("trim queues a second operation", p.locator(".op").count() == 2)

    with p.expect_download(timeout=45000) as dl2:
        p.click("#export-btn")
    out2 = "/tmp/audio-out2.wav"
    dl2.value.save_as(out2)
    with wave.open(out2) as w:
        d2 = w.getnframes() / w.getframerate()
    # A 2-second section played at 2x should last about one second.
    check("trim and speed compose", 0.85 < d2 < 1.2, f"{d2:.2f}s")

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
