import sys, os
from playwright.sync_api import sync_playwright

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")
    p.set_input_files("#file-input", [f"{S}/bars.png", f"{S}/gradient.png"])
    p.wait_for_timeout(2500)

    check("both images are on the bench", p.locator(".image-cell").count() == 2,
          str(p.locator(".image-cell").count()))

    src = lambda i: p.evaluate(f"() => document.querySelectorAll('.image-cell img')[{i}]?.src ?? ''")
    before = [src(0), src(1)]

    # Choosing a look is the change: the preview updates and the stack records it.
    p.select_option("#look-select", "black-and-white")
    p.wait_for_timeout(2500)
    after = [src(0), src(1)]
    check("choosing a look updates the preview at once", after != before)
    check("and lands on the stack without an Apply step", p.locator(".op").count() == 1,
          f"{p.locator('.op').count()} operations")

    # Strength rewrites that same row rather than adding another.
    p.locator("#look-strength").fill("30")
    p.wait_for_timeout(2500)
    weaker = [src(0), src(1)]
    check("strength previews live too", weaker != after)
    check("dragging strength does not pile up rows", p.locator(".op").count() == 1,
          f"{p.locator('.op').count()} operations")
    check("strength label follows the slider", "30%" in p.inner_text("#look-strength-value"),
          p.inner_text("#look-strength-value"))

    # Applying must add exactly one operation for both images.
    p.wait_for_timeout(1500)
    check("a look over two images is ONE operation",
          p.locator(".op").count() == 1, f"{p.locator('.op').count()} operations")
    summary = p.inner_text(".op-summary")
    # The row covers the photographs as a set, not a fixed list, so it must not
    # name a count that dropping another photo in would make wrong.
    check("the operation says it covers the whole set", "every photo" in summary, summary)

    # And undoing it in one click affects both.
    p.locator(".op input[type=checkbox]").first.uncheck()
    p.wait_for_timeout(2000)
    check("one click undoes the batch for every image", p.locator(".op").count() == 1)

    p.locator(".op input[type=checkbox]").first.check()
    p.wait_for_timeout(1500)

    # Images get the enlarged viewer too.
    p.locator(".image-cell").first.hover()
    p.locator(".image-cell").first.locator(".cell-button").first.click()
    p.wait_for_timeout(800)
    check("images open in the enlarged viewer", p.locator(".viewer:not([hidden])").count() == 1)
    check("viewer captions the image by name", "bars.png" in p.inner_text(".viewer-caption"),
          p.inner_text(".viewer-caption"))
    check("the caption says where you are in the set",
          "1 of 2" in p.inner_text(".viewer-caption"), p.inner_text(".viewer-caption"))
    p.keyboard.press("ArrowRight")
    p.wait_for_timeout(500)
    check("arrow keys move between images", "gradient.png" in p.inner_text(".viewer-caption"),
          p.inner_text(".viewer-caption"))
    p.keyboard.press("Escape")
    p.wait_for_timeout(300)
    check("escape closes the image viewer", p.locator(".viewer:not([hidden])").count() == 0)

    # Thumbnail size sliders.
    w_before = p.evaluate("() => document.querySelector('.image-cell').getBoundingClientRect().width")
    p.locator("#image-thumb-size").fill("340")
    p.wait_for_timeout(500)
    w_after = p.evaluate("() => document.querySelector('.image-cell').getBoundingClientRect().width")
    check("the image size slider enlarges the thumbnails", w_after > w_before,
          f"{round(w_before)} -> {round(w_after)}")

    p.set_input_files("#file-input", f"{S}/sample.pdf")
    p.wait_for_timeout(2500)
    pw_before = p.evaluate("() => document.querySelector('.page-cell')?.getBoundingClientRect().width ?? 0")
    p.locator("#thumb-size").fill("260")
    p.wait_for_timeout(500)
    pw_after = p.evaluate("() => document.querySelector('.page-cell')?.getBoundingClientRect().width ?? 0")
    check("the page size slider enlarges PDF thumbnails", pw_after > pw_before,
          f"{round(pw_before)} -> {round(pw_after)}")

    # Each photograph carries its own controls, so nothing about it is repeated
    # in a list above the grid. A PDF still gets a row, since it has no grid of
    # its own to hang controls on.
    check("photographs are not also listed above the grid",
          p.locator(".asset-image").count() == 0,
          f"{p.locator('.asset-image').count()} image chips")
    check("every cell has a view and a remove control",
          p.locator(".cell-button").count() == p.locator(".image-cell").count() * 2)

    # Dragging one photograph into the gap before another moves it.
    #
    # The zoom is turned down first so the grid is more than one column wide.
    # That is the normal case, and it is the one a synthetic drag can drive:
    # Playwright's drag_to needs a target with room around it, and a single
    # column leaves no horizontal gap to aim at.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")

    # The PDF loaded above owns the zoom slot while it is on the bench, and only
    # one slider is shown at a time, so it goes before the photo zoom can be
    # reached again. Two sliders side by side was a bug, not a feature.
    p.evaluate("""async () => {
        const { getState, removeAsset } = await import('./src/core/workspace.js');
        for (const a of getState().assets.filter(a => a.kind === 'pdf')) removeAsset(a.id);
    }""")
    p.wait_for_timeout(1200)
    check("only one zoom slider is ever on screen",
          p.locator("#bench-zoom .zoom-control:visible").count() == 1,
          f"{p.locator('#bench-zoom .zoom-control:visible').count()} visible")

    p.locator("#image-thumb-size").fill("140")
    p.wait_for_timeout(2500)

    order = lambda: p.evaluate("() => [...document.querySelectorAll('.image-name')].map(e=>e.textContent)")
    before_order = order()
    target = p.locator(".image-cell").nth(0).bounding_box()
    p.locator(".image-cell").nth(1).drag_to(
        p.locator(".image-cell").nth(0),
        target_position={"x": 3, "y": target["height"] / 2},
    )
    p.wait_for_timeout(2500)
    check("dragging a photograph reorders the bench", order() != before_order,
          f"{before_order} -> {order()}")

    # Rotation folds rather than stacking: two lefts are a half turn, and a left
    # then a right is no rotation at all.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    p.wait_for_timeout(500)

    rotations = lambda: [t for t in p.evaluate(
        "() => [...document.querySelectorAll('.op-summary')].map(e=>e.textContent)")
        if "Rotate" in t]

    p.click("#image-rotate-left"); p.wait_for_timeout(900)
    check("one turn queues one rotation", len(rotations()) == 1, str(rotations()))

    p.click("#image-rotate-left"); p.wait_for_timeout(900)
    check("two turns stay one row", len(rotations()) == 1, str(rotations()))
    check("and add up to a half turn", "180" in (rotations()[0] if rotations() else ""),
          str(rotations()))

    p.click("#image-rotate-right"); p.wait_for_timeout(900)
    check("turning back subtracts", "270" in (rotations()[0] if rotations() else ""),
          str(rotations()))

    p.click("#image-rotate-right"); p.wait_for_timeout(900)
    check("returning to square removes the row entirely", len(rotations()) == 0,
          str(rotations()))


    # --- Photos added later inherit the edits already made -------------------
    # The bug this guards: grade the photographs, drop four more in, and the new
    # ones arrived ungraded while the stack claimed to cover everything.
    # Start from a clean stack and a neutral control, so choosing the look below
    # really fires a change rather than re-selecting what is already set.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    p.select_option("#look-select", "")
    p.wait_for_timeout(800)
    # An earlier block left the strength at 30%; a partial grade is not what this
    # check is about, so put it back to full.
    p.locator("#look-strength").fill("100")
    p.wait_for_timeout(500)
    p.select_option("#look-select", "black-and-white")
    p.wait_for_timeout(3000)
    grey = lambda i: p.evaluate(
        "(i) => { const img=document.querySelectorAll('.image-cell img')[i];"
        " if(!img) return -1;"
        " const c=document.createElement('canvas'); c.width=40; c.height=40;"
        " const x=c.getContext('2d'); x.drawImage(img,0,0,40,40);"
        " const d=x.getImageData(0,0,40,40).data; let s=0,n=0;"
        " for(let j=0;j<d.length;j+=4){s+=Math.max(d[j],d[j+1],d[j+2])-Math.min(d[j],d[j+1],d[j+2]);n++;}"
        " return Math.round(s/n); }", i)
    graded = grey(0)
    check("the loaded photographs are graded", graded == 0, str(graded))

    rows_before = p.locator(".op").count()
    p.set_input_files("#file-input", [f"{S}/rotated.png"])
    p.wait_for_timeout(3000)

    check("the new photograph joins the bench", p.locator(".image-cell").count() == 3,
          str(p.locator(".image-cell").count()))
    last = grey(p.locator(".image-cell").count() - 1)
    check("a photograph added after the edit arrives graded too", last == 0, str(last))
    check("and it does not add a second row to the stack",
          p.locator(".op").count() == rows_before, str(p.locator(".op").count()))

    p.select_option("#look-select", "")
    p.wait_for_timeout(1500)


    # --- Undo, in the header ------------------------------------------------
    # Three retreats of increasing size: Undo takes back the last change, Undo
    # all drops every edit, Start over clears the bench.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    p.wait_for_timeout(800)
    check("undo is hidden when there is nothing to take back",
          p.locator("#undo-last").is_visible() is False)

    p.click("#image-rotate-right"); p.wait_for_timeout(1200)
    p.select_option("#look-select", "black-and-white"); p.wait_for_timeout(2500)
    rows = lambda: p.locator(".op").count()
    before = rows()
    check("undo appears once there is a change", p.locator("#undo-last").is_visible(),
          str(before))

    # The two ways back sit together beside the name, not at opposite ends of
    # the header: they are the same kind of decision at different sizes.
    check("undo sits beside start over",
          p.locator(".topbar-back #undo-last").count() == 1
          and p.locator(".topbar-back #start-over").count() == 1)

    # It takes back the newest change, and does not stop to ask.
    p.click("#undo-last"); p.wait_for_timeout(1500)
    check("undo removes exactly one row", rows() == before - 1, f"{before} -> {rows()}")
    left = p.evaluate("()=>[...document.querySelectorAll('.op-summary')].map(e=>e.textContent)")
    check("and it is the most recent one that goes",
          not any("look" in t for t in left), str(left))

    p.keyboard.press("Meta+z"); p.wait_for_timeout(1500)
    check("the keyboard shortcut does the same", rows() == before - 2, str(rows()))
    check("undo hides again when the stack is empty",
          p.locator("#undo-last").is_visible() is False)

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    p.screenshot(path=f"{S}/../live-preview.png", full_page=True)
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
