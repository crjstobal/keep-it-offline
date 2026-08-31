import sys
from playwright.sync_api import sync_playwright
import os
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
    check("image editor hidden with an empty bench", p.locator("#image-editor").is_hidden())

    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(2000)

    check("image editor appears once an image is loaded", p.locator("#image-editor").is_visible())
    check("all five looks are offered", p.locator("#look-select option").count() == 5,
          str(p.locator("#look-select option").count()))
    check("a preview thumbnail is rendered", p.locator(".image-cell img").count() == 1)

    before = p.evaluate("() => document.querySelector('.image-cell img')?.src ?? ''")
    check("preview has a source", before.startswith("blob:"), before[:40])

    # Apply a look by hand and confirm the preview actually changes.
    p.select_option("#look-select", "black-and-white")
    p.click("#apply-look")
    p.wait_for_timeout(2000)

    check("look queues an operation", p.locator(".op").count() == 1)
    check("operation is tagged as the user's", p.locator(".badge-user").count() == 1)
    after = p.evaluate("() => document.querySelector('.image-cell img')?.src ?? ''")
    check("preview updates after applying a look", after != before, f"{before[:30]} -> {after[:30]}")

    # The preview must reflect the stack: disabling the op should restore colour.
    p.locator(".op input[type=checkbox]").first.uncheck()
    p.wait_for_timeout(2000)
    restored = p.evaluate("() => document.querySelector('.image-cell img')?.src ?? ''")
    check("unchecking the look updates the preview again", restored != after)

    p.locator(".op input[type=checkbox]").first.check()
    p.wait_for_timeout(1500)

    # Strength slider.
    p.fill("#resize-width", "200")
    p.click("#apply-resize")
    p.wait_for_timeout(1500)
    check("resize queues a second operation", p.locator(".op").count() == 2)

    p.select_option("#format-select", "webp")
    p.click("#apply-format")
    p.wait_for_timeout(1500)
    check("convert queues a third operation", p.locator(".op").count() == 3)
    check("export button is enabled with a full stack",
          not p.locator("#export-btn").is_disabled())

    # Download the result and confirm the pipeline ran.
    with p.expect_download(timeout=15000) as dl:
        p.click("#export-btn")
    download = dl.value
    check("export produces a download", download.suggested_filename.endswith(".webp"),
          download.suggested_filename)

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    p.screenshot(path=f"{S}/image-panel.png", full_page=True)
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
