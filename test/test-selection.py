# Picking files out by hand.
#
# The rule this suite defends: selecting nothing means every file of a kind, and
# selecting some means only those. Everything else follows from that, including
# what the stack says a change covered, which is the only record the user has of
# what they just did to forty photographs.

import sys
import os
from playwright.sync_api import sync_playwright

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0


def check(n, c, extra=""):
    global passed, failed
    if c:
        passed += 1
        print(f"  ok  {n}")
    else:
        failed += 1
        print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))


with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    p.on("dialog", lambda d: d.accept())

    p.goto("http://localhost:8899/index.html")
    p.set_input_files("#file-input", [f"{S}/bars.png", f"{S}/gradient.png", f"{S}/rotated.png"])
    p.wait_for_timeout(3000)

    cells = p.locator(".image-cell")
    check("three photographs are on the bench", cells.count() == 3, str(cells.count()))

    # --- The default: nothing picked means everything -----------------------
    scope = p.locator("#image-scope")
    check("the scope line starts by saying every image",
          "every loaded image" in scope.inner_text(), scope.inner_text())
    check("nothing is picked to begin with", p.locator(".image-cell.is-picked").count() == 0)
    check("Clear is not offered with nothing picked",
          p.locator("#image-select-none").is_hidden())

    p.select_option("#look-select", "black-and-white")
    p.wait_for_timeout(2500)
    summary = p.locator(".op-summary").first.inner_text()
    check("with nothing picked the change covers every photo",
          "every photo" in summary, summary)

    # Every photograph must actually be covered, not just described that way.
    covered = p.evaluate("""async () => {
        const ws = await import('./src/core/workspace.js');
        return ws.getState().assets.filter(a => a.kind === 'image')
                 .map(a => ws.operationsFor(a.id).length);
    }""")
    check("every photo carries the change", covered == [1, 1, 1], str(covered))

    p.locator(".op .ghost").first.click()
    p.wait_for_timeout(500)
    p.select_option("#look-select", "")
    p.wait_for_timeout(500)

    # --- Picking two out ----------------------------------------------------
    cells.nth(0).click()
    cells.nth(2).click()
    p.wait_for_timeout(600)

    check("two photographs are picked", p.locator(".image-cell.is-picked").count() == 2,
          str(p.locator(".image-cell.is-picked").count()))
    check("the scope line counts what is picked",
          "2 selected photos" in p.locator("#image-scope").inner_text(),
          p.locator("#image-scope").inner_text())
    check("Clear is offered once something is picked",
          p.locator("#image-select-none").is_visible())

    p.select_option("#look-select", "black-and-white")
    p.wait_for_timeout(2500)

    summary = p.locator(".op-summary").first.inner_text()
    check("the change names the selection rather than everything",
          "2 selected photos" in summary, summary)

    covered = p.evaluate("""async () => {
        const ws = await import('./src/core/workspace.js');
        return ws.getState().assets.filter(a => a.kind === 'image')
                 .map(a => ws.operationsFor(a.id).length);
    }""")
    check("only the picked photographs carry the change", covered == [1, 0, 1], str(covered))

    # The point of the whole feature: the untouched one is still untouched.
    check("the unpicked photograph has no operations", covered[1] == 0)

    # --- A pinned change does not spread ------------------------------------
    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(2500)
    covered = p.evaluate("""async () => {
        const ws = await import('./src/core/workspace.js');
        return ws.getState().assets.filter(a => a.kind === 'image')
                 .map(a => ws.operationsFor(a.id).length);
    }""")
    check("a photo added later does not inherit a pinned change",
          len(covered) == 4 and covered[3] == 0, str(covered))

    # --- Changing the selection starts a new row ----------------------------
    # A live control must not silently redirect a change already on the stack to
    # a different set of photographs.
    before = p.locator(".op").count()
    p.click("#image-select-none")
    p.wait_for_timeout(400)
    cells.nth(1).click()
    p.wait_for_timeout(400)
    p.select_option("#look-select", "warm")
    p.wait_for_timeout(2500)

    check("a look over a new selection adds its own row",
          p.locator(".op").count() == before + 1,
          f"{before} -> {p.locator('.op').count()}")

    summaries = p.locator(".op-summary").all_inner_texts()
    check("the earlier row still says what it covered",
          any("2 selected photos" in s for s in summaries), str(summaries))

    # --- Select all, and clearing -------------------------------------------
    p.click("#image-select-all")
    p.wait_for_timeout(500)
    check("Select all picks every photograph",
          p.locator(".image-cell.is-picked").count() == 4,
          str(p.locator(".image-cell.is-picked").count()))
    check("Select all hides itself once everything is picked",
          p.locator("#image-select-all").is_hidden())

    p.click("#image-select-none")
    p.wait_for_timeout(500)
    check("Clear puts it back to covering everything",
          "every loaded image" in p.locator("#image-scope").inner_text(),
          p.locator("#image-scope").inner_text())
    check("Clear leaves nothing picked", p.locator(".image-cell.is-picked").count() == 0)

    # --- Clicking away lets everything go ------------------------------------
    # Expected of anything holding a selection, and it saves hunting for Clear.
    # The bar is high on purpose: only a click that landed on nothing counts.
    cells.nth(0).click()
    p.wait_for_timeout(400)
    check("a photograph is picked again", p.locator(".image-cell.is-picked").count() == 1)

    bench = p.locator(".bench").bounding_box()
    p.mouse.click(bench["x"] + bench["width"] / 2, bench["y"] + bench["height"] - 10)
    p.wait_for_timeout(500)
    check("clicking the empty bench clears the selection",
          p.locator(".image-cell.is-picked").count() == 0)

    # A control is not empty space: reaching for a slider must not lose the
    # selection you were about to apply it to.
    cells.nth(0).click()
    p.wait_for_timeout(400)
    p.locator("#look-strength").click()
    p.wait_for_timeout(400)
    check("clicking a control in the rail keeps the selection",
          p.locator(".image-cell.is-picked").count() == 1)

    # Nor is a drag: dropping a photograph in open space is a reorder.
    a_box = cells.nth(0).bounding_box()
    b_box = cells.nth(1).bounding_box()
    p.mouse.move(a_box["x"] + a_box["width"] / 2, a_box["y"] + a_box["height"] / 2)
    p.mouse.down()
    p.mouse.move(b_box["x"] + b_box["width"] / 2, b_box["y"] + b_box["height"] / 2, steps=12)
    p.mouse.up()
    p.wait_for_timeout(600)
    check("dragging to reorder does not clear the selection",
          p.locator(".image-cell.is-picked").count() == 1)

    p.click("#image-select-none")
    p.wait_for_timeout(400)

    # --- Removing a picked file ---------------------------------------------
    cells.nth(0).click()
    p.wait_for_timeout(400)
    p.locator(".image-cell").first.hover()
    p.locator(".image-cell").first.locator(".cell-remove").click()
    p.wait_for_timeout(1200)
    check("removing a picked photograph drops it from the selection",
          p.evaluate("""async () => {
              const ws = await import('./src/core/workspace.js');
              return ws.selectedAssets('image').length;
          }""") == 0)

    # --- The agent sees the same selection ----------------------------------
    p.evaluate("""async () => {
        const ws = await import('./src/core/workspace.js');
        const first = ws.listAssets('image')[0];
        ws.setSelection([first.id], 'image');
    }""")
    p.wait_for_timeout(500)
    check("a selection made in code lights up the same cell",
          p.locator(".image-cell.is-picked").count() == 1,
          str(p.locator(".image-cell.is-picked").count()))

    # --- Kinds do not disturb each other -------------------------------------
    p.set_input_files("#file-input", f"{S}/tone.mp3")
    p.wait_for_timeout(2500)
    check("a track arrives with its own scope line",
          "every loaded track" in p.locator("#audio-scope").inner_text(),
          p.locator("#audio-scope").inner_text())
    check("picking a photo did not pick the track",
          p.locator(".audio-row.is-picked").count() == 0)
    check("the photo selection survived the track arriving",
          p.locator(".image-cell.is-picked").count() == 1)

    p.locator(".audio-row .row-pick").first.check()
    p.wait_for_timeout(500)
    check("a track can be picked out", p.locator(".audio-row.is-picked").count() == 1)
    check("picking a track leaves the photo picked",
          p.locator(".image-cell.is-picked").count() == 1)

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
