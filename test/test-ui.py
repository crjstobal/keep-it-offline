import sys
from playwright.sync_api import sync_playwright

import os
S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
SAMPLE = os.path.join(S, "sample.pdf")
passed, failed = 0, 0

def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1; print(f"  ok  {name}")
    else:
        failed += 1; print(f"  FAIL {name}" + (f"\n       {extra}" if extra else ""))

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto("http://localhost:8899/index.html")
    page.set_input_files("#file-input", SAMPLE)
    page.wait_for_selector(".page-cell:not(.is-loading)", timeout=15000)
    page.wait_for_timeout(1500)

    cells = page.locator(".page-cell")
    check("all 6 pages rendered", cells.count() == 6, f"got {cells.count()}")
    check("no page errors on load", not errors, "; ".join(errors[:3]))

    # Select all
    page.click('[data-select="all"]')
    check("select all selects 6", "6 pages selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))

    # Select even
    page.click('[data-select="even"]')
    check("select even selects 3", "3 pages selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))

    # Rotate them and measure containment.
    page.click("#rotate-right")
    page.wait_for_timeout(600)

    # The frame clips, so measure the visible result: the intersection of the
    # image with its frame must still sit inside the cell.
    overflow = page.evaluate("""() => {
        const bad = [];
        for (const cell of document.querySelectorAll('.page-cell')) {
            const img = cell.querySelector('img');
            const frame = cell.querySelector('.page-frame');
            if (!img || !frame) continue;
            const c = cell.getBoundingClientRect();
            const f = frame.getBoundingClientRect();
            const i = img.getBoundingClientRect();
            const vis = {
                left: Math.max(f.left, i.left), right: Math.min(f.right, i.right),
                top: Math.max(f.top, i.top), bottom: Math.min(f.bottom, i.bottom),
            };
            if (vis.left < c.left - 1 || vis.right > c.right + 1 ||
                vis.top < c.top - 1 || vis.bottom > c.bottom + 1) {
                bad.push({page: cell.dataset.index,
                          cell: [Math.round(c.left), Math.round(c.right)],
                          visible: [Math.round(vis.left), Math.round(vis.right)]});
            }
        }
        return bad;
    }""")

    # And the page must not be clipped away: what shows has to keep the whole
    # rotated page, not a cropped slice of it.
    clipped = page.evaluate("""() => {
        const bad = [];
        for (const cell of document.querySelectorAll('.page-cell.is-quarter-turned')) {
            const img = cell.querySelector('img');
            const frame = cell.querySelector('.page-frame');
            if (!img || !frame) continue;
            const f = frame.getBoundingClientRect();
            const i = img.getBoundingClientRect();
            // Rotated bounds: width and height swap.
            const rw = i.height, rh = i.width;
            if (rw > f.width + 1 || rh > f.height + 1) {
                bad.push({page: cell.dataset.index,
                          rotated: [Math.round(rw), Math.round(rh)],
                          frame: [Math.round(f.width), Math.round(f.height)]});
            }
        }
        return bad;
    }""")
    check("rotated page is not clipped by its frame", not clipped, str(clipped[:3]))

    # A square frame cannot hold the same long edge both upright and turned, so
    # a turned page is necessarily drawn smaller. What must hold is that it stays
    # legible rather than shrinking to nothing.
    sizes = page.evaluate("""() => {
        const up = [...document.querySelectorAll('.page-cell:not(.is-quarter-turned) img')][0];
        const turned = [...document.querySelectorAll('.page-cell.is-quarter-turned img')][0];
        if (!up || !turned) return null;
        const u = up.getBoundingClientRect(), t = turned.getBoundingClientRect();
        return {upLong: Math.round(Math.max(u.width, u.height)),
                turnedLong: Math.round(Math.max(t.width, t.height))};
    }""")
    check("rotated page stays a reasonable size",
          sizes and sizes["turnedLong"] >= sizes["upLong"] * 0.6, str(sizes))

    check("rotated pages stay inside their cell", not overflow, str(overflow[:3]))

    rotated = page.evaluate("""() => [...document.querySelectorAll('.page-cell')]
        .map(c => ({i: c.dataset.index, turned: c.classList.contains('is-quarter-turned'),
                    rot: c.querySelector('img')?.style.rotate}))""")
    turned = [r for r in rotated if r["turned"]]
    check("3 pages marked quarter-turned", len(turned) == 3, str(rotated))

    # Grid must not overflow its container horizontally.
    grid_ok = page.evaluate("""() => {
        const g = document.querySelector('.page-grid');
        return g.scrollWidth <= g.clientWidth + 1;
    }""")
    check("grid does not overflow horizontally", grid_ok)

    # Operation stack got the rotation, tagged as user.
    ops = page.locator(".op").count()
    check("rotation queued on the stack", ops == 1, f"{ops} operations")
    check("operation tagged 'you'", page.locator(".badge-user").count() == 1)

    # Remove selected, then confirm pages grey out rather than vanish.
    page.click('[data-select="odd"]')
    page.click("#remove-selected")
    page.wait_for_timeout(500)
    check("removal queued", page.locator(".op").count() == 2)
    check("removed pages greyed, not deleted",
          cells.count() == 6 and page.locator(".page-cell.is-removed").count() == 3,
          f"cells={cells.count()} removed={page.locator('.page-cell.is-removed').count()}")

    # Undo by unchecking, and the greying must reverse.
    page.locator(".op input[type=checkbox]").last.uncheck()
    page.wait_for_timeout(400)
    check("unchecking undoes the removal",
          page.locator(".page-cell.is-removed").count() == 0,
          f"still removed: {page.locator('.page-cell.is-removed').count()}")

    # --- Selection ergonomics ---------------------------------------------
    page.click('[data-select="none"]')

    # Clicking anywhere on the card selects it, not just the small checkbox.
    page.locator(".page-cell").nth(0).click(position={"x": 60, "y": 120})
    check("clicking the card body selects it",
          "1 page selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))
    check("checkbox reflects card click",
          page.locator(".page-cell").nth(0).locator(".page-check").is_checked())

    # Clicking again deselects.
    page.locator(".page-cell").nth(0).click(position={"x": 60, "y": 120})
    check("clicking again deselects", "No pages selected" in page.inner_text("#selection-count"))

    # Shift-click selects the range between the anchor and the target.
    page.locator(".page-cell").nth(1).click(position={"x": 60, "y": 120})
    page.locator(".page-cell").nth(4).click(position={"x": 60, "y": 120}, modifiers=["Shift"])
    check("shift-click selects a range",
          "4 pages selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))

    # Rotation keeps the selection so the same pages can be turned again.
    before = page.inner_text("#selection-count")
    page.click("#rotate-right")
    page.wait_for_timeout(300)
    check("rotation keeps the selection", page.inner_text("#selection-count") == before,
          f"{before} -> {page.inner_text('#selection-count')}")

    # Removal clears it, since those pages are gone.
    page.click("#remove-selected")
    page.wait_for_timeout(300)
    check("removal clears the selection",
          "No pages selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))

    # --- Enlarged viewer ---------------------------------------------------
    page.locator(".page-cell").nth(0).hover()
    page.locator(".page-cell").nth(0).locator(".page-zoom").click()
    page.wait_for_timeout(400)
    check("zoom button opens the viewer", page.locator(".viewer:not([hidden])").count() == 1)
    check("viewer shows the right page", "page 1 of 6" in page.inner_text(".viewer-caption"),
          page.inner_text(".viewer-caption"))
    # The viewer can be opened from any of several documents, so it says which.
    check("and says which document it came from",
          "sample.pdf" in page.inner_text(".viewer-caption"),
          page.inner_text(".viewer-caption"))

    # Opening the viewer must not change the selection.
    check("opening the viewer does not select",
          "No pages selected" in page.inner_text("#selection-count"),
          page.inner_text("#selection-count"))

    # Arrow keys page through the document.
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(300)
    check("arrow key advances a page", "page 2 of 6" in page.inner_text(".viewer-caption"),
          page.inner_text(".viewer-caption"))

    # The viewer renders at a higher resolution than the thumbnail.
    natural = page.evaluate("() => document.querySelector('.viewer-image')?.naturalWidth ?? 0")
    check("viewer renders at full size, not a blown-up thumbnail", natural > 400, f"naturalWidth={natural}")

    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    check("escape closes the viewer", page.locator(".viewer:not([hidden])").count() == 0)

    # Pages reorder by dragging, into the gap the marker draws.
    page.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    page.wait_for_timeout(400)

    src_box = page.locator(".page-cell").nth(2).bounding_box()
    dst_box = page.locator(".page-cell").nth(0).bounding_box()
    page.mouse.move(src_box["x"] + src_box["width"]/2, src_box["y"] + src_box["height"]/2)
    page.mouse.down()
    page.mouse.move(dst_box["x"] + 2, dst_box["y"] + dst_box["height"]/2, steps=12)
    page.wait_for_timeout(400)
    check("a marker shows where a page will land",
          page.locator(".page-cell.drop-before, .page-cell.drop-after").count() == 1)
    page.mouse.up()
    page.wait_for_timeout(1500)
    moves = [t for t in page.evaluate("() => [...document.querySelectorAll('.op-summary')].map(e=>e.textContent)") if "Move page" in t]
    check("dragging a page queues a reorder", len(moves) == 1, str(moves))

    check("no errors during interaction", not errors, "; ".join(errors[:3]))

    page.screenshot(path=f"{S}/rotated.png", full_page=True)
    browser.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
