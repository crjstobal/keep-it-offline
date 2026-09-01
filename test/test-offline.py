# The promise, as a test.
#
# "Nothing leaves your computer" is the whole product. It is also the kind of
# claim that quietly stops being true the day someone adds a font, an analytics
# snippet or a CDN import, so it is asserted here rather than trusted.

import sys, os
from playwright.sync_api import sync_playwright

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

LOCAL = ("http://localhost:8899", "blob:", "data:")

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900})
    external, errors = [], []
    p.on("request", lambda r: external.append(r.url) if not r.url.startswith(LOCAL) else None)
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")
    p.wait_for_timeout(1500)
    check("loading the page contacts nobody", not external, "; ".join(external[:4]))

    # Exercise every pipeline: each one pulls in a different library.
    p.set_input_files("#file-input", [f"{S}/sample.pdf", f"{S}/bars.png"])
    p.wait_for_timeout(5000)
    check("the PDF renders (pdf.js is local)", p.locator(".page-cell").count() > 0,
          str(p.locator(".page-cell").count()))
    check("the photograph renders", p.locator(".image-cell").count() == 1)

    p.select_option("#look-select", "black-and-white")
    p.wait_for_timeout(2500)
    check("grading a photograph contacts nobody", not external, "; ".join(external[:4]))

    # The typeface has to be ours, not fetched from a font host.
    check("the typeface is served from this origin",
          "Instrument Sans" in p.evaluate("() => getComputedStyle(document.body).fontFamily"),
          p.evaluate("() => getComputedStyle(document.body).fontFamily"))

    check("no request left this origin, start to finish", not external,
          "; ".join(external[:6]))
    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
