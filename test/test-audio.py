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

    # Trim by dragging the timeline handles, which is how a person does it.
    box = p.locator(".timeline").bounding_box()
    start_handle = p.locator(".timeline-handle-start")
    end_handle = p.locator(".timeline-handle-end")

    # Drag the start handle to a quarter in, and the end handle to three quarters.
    sb = start_handle.bounding_box()
    p.mouse.move(sb["x"] + sb["width"]/2, sb["y"] + sb["height"]/2)
    p.mouse.down()
    p.mouse.move(box["x"] + box["width"]*0.25, sb["y"] + sb["height"]/2, steps=8)
    p.mouse.up()
    p.wait_for_timeout(400)

    eb = end_handle.bounding_box()
    p.mouse.move(eb["x"] + eb["width"]/2, eb["y"] + eb["height"]/2)
    p.mouse.down()
    p.mouse.move(box["x"] + box["width"]*0.75, eb["y"] + eb["height"]/2, steps=8)
    p.mouse.up()
    p.wait_for_timeout(400)

    p.click("text=Trim to selection")
    p.wait_for_timeout(800)
    check("dragging the handles and trimming queues an operation",
          p.locator(".op").count() == 2, f"{p.locator('.op').count()} ops")
    summary = p.locator(".op-summary").last.inner_text()
    check("the trim covers roughly the dragged range",
          "1." in summary or "0.9" in summary, summary)

    with p.expect_download(timeout=45000) as dl2:
        p.click("#export-btn")
    out2 = "/tmp/audio-out2.wav"
    dl2.value.save_as(out2)
    with wave.open(out2) as w:
        d2 = w.getnframes() / w.getframerate()
    # Half the track (dragged) played at 2x should last about a second.
    check("trim and speed compose", 0.7 < d2 < 1.4, f"{d2:.2f}s")

    # Playback has to actually run, or a trim is still being guessed at.
    # Headless Chromium blocks autoplay unless it is launched permissively, so
    # this drives the element the same way the button does and checks it starts.
    # The Audio object is created in script and never appended to the DOM, so
    # it is reached by clicking the control the user clicks.
    p.click(".play-button")
    p.wait_for_timeout(800)
    state = p.evaluate("""() => {
        const head = document.querySelector('.timeline-playhead');
        return head ? parseFloat(head.style.left) || 0 : -1;
    }""")
    check("playing advances the play head", state > 0, f"playhead at {state}")
    p.click(".play-button")

    # The play button has to be wired to something, whatever autoplay policy says.
    check("a play control is present for the track", p.locator(".play-button").count() == 1)

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
