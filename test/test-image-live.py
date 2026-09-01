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
    check("the operation says how many files it covers", "2 images" in summary, summary)

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

    # Dragging one photograph onto another moves it.
    order = lambda: p.evaluate("() => [...document.querySelectorAll('.image-name')].map(e=>e.textContent)")
    before_order = order()
    p.locator(".image-cell").nth(1).drag_to(p.locator(".image-cell").nth(0))
    p.wait_for_timeout(2500)
    check("dragging a photograph reorders the bench", order() != before_order,
          f"{before_order} -> {order()}")

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    p.screenshot(path=f"{S}/../live-preview.png", full_page=True)
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
