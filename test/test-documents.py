# Two PDFs on the bench, and what makes them two.
#
# The rule this suite defends: every loaded document is on screen, each one told
# apart from the others by a heading and a coloured edge, and that distinction
# disappears the moment the documents become one, whether by dragging a page
# across the boundary or by joining them outright. A distinction that survived
# the merge would be a lie about what is in the file.

import os
import sys
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


def assets(page):
    """The documents on the bench, which is what the user can see and act on."""
    return page.evaluate(
        """async () => {
        const w = await import('./src/core/workspace.js');
        return w.listAssets('pdf').map(a => ({id: a.id, name: a.name, pages: a.meta.pageCount}));
    }"""
    )


def ops(page):
    return page.eval_on_selector_all(".op-summary", "e => e.map(x => x.textContent.trim())")


def drag_page(page, from_sel, to_sel, edge=4):
    """Drag one page cell onto the left edge of another."""
    src = page.query_selector(from_sel)
    dst = page.query_selector(to_sel)
    src.hover()
    page.mouse.down()
    box = dst.bounding_box()
    page.mouse.move(box["x"] + edge, box["y"] + box["height"] / 2, steps=12)
    page.wait_for_timeout(300)
    page.mouse.up()
    page.wait_for_timeout(4000)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1500, "height": 1100})
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")

    # --- One document is not told apart from anything ------------------------
    p.set_input_files("#file-input", f"{S}/sample.pdf")
    p.wait_for_selector(".page-cell:not(.is-loading)", timeout=15000)
    check("a lone PDF gets no heading", p.locator(".page-group-head").count() == 0)
    check("all its pages are drawn", p.locator(".page-cell").count() == 6,
          str(p.locator(".page-cell").count()))

    # --- A second document arrives -------------------------------------------
    p.set_input_files("#file-input", f"{S}/sensitive.pdf")
    p.wait_for_timeout(4000)

    check("both documents get a group", p.locator(".page-group").count() == 2,
          str(p.locator(".page-group").count()))
    check("every page of both is on screen", p.locator(".page-cell").count() == 8,
          str(p.locator(".page-cell").count()))

    names = p.eval_on_selector_all(".page-group-name", "e => e.map(x => x.textContent)")
    check("each group is named after its file", names == ["sample.pdf", "sensitive.pdf"], str(names))

    bands = p.eval_on_selector_all(".page-group", "e => e.map(g => g.dataset.band)")
    check("the groups carry different colour bands", len(set(bands)) == 2, str(bands))

    chips = p.eval_on_selector_all(".asset-pdf", "e => e.map(c => c.dataset.band)")
    check("the file chips are tinted to match", chips == bands, f"{chips} vs {bands}")

    # A page belongs to its document, not to a position on the bench: the second
    # document's pages are numbered from one again.
    labels = p.eval_on_selector_all(
        ".page-group[data-asset-id=pdf_2] .page-number", "e => e.map(x => x.textContent)"
    )
    check("the second document numbers its pages from one", labels == ["1", "2"], str(labels))

    # --- Editing one document leaves the other alone -------------------------
    p.evaluate(
        """async () => {
        const w = await import('./src/core/workspace.js');
        const first = w.getState().assets[0];
        w.pushOperation({ type: 'remove_pages', assetIds: first.id, params: { pages: [0] },
                          summary: 'Remove page 1', source: 'user' });
    }"""
    )
    p.wait_for_timeout(600)
    check(
        "a removal greys only its own document",
        p.locator(".page-group[data-asset-id=pdf_1] .page-cell.is-removed").count() == 1
        and p.locator(".page-group[data-asset-id=pdf_2] .page-cell.is-removed").count() == 0,
    )
    p.evaluate(
        """async () => {
        const w = await import('./src/core/workspace.js');
        w.clearOperations();
    }"""
    )
    p.wait_for_timeout(400)

    # --- Dragging a page across the boundary joins the two -------------------
    drag_page(
        p,
        ".page-group[data-asset-id=pdf_2] .page-cell",
        ".page-group[data-asset-id=pdf_1] .page-cell",
    )

    after = assets(p)
    check("the two documents became one", len(after) == 1, str(after))
    check("the joined document holds every page", after[0]["pages"] == 8, str(after))
    check("it is named after both", after[0]["name"] == "sample-sensitive.pdf", str(after))
    check("there is nothing left to tell apart", p.locator(".page-group-head").count() == 0)
    check("and no colour band survives", p.locator(".page-group").count() == 1)

    # The whole gesture is one row on the stack: joining and placing the page are
    # one thing the user did, and so one thing to undo.
    rows = ops(p)
    check("the join is recorded on the stack", len(rows) == 1, str(rows))
    check(
        "and it says which documents it joined",
        "sample.pdf" in rows[0] and "sensitive.pdf" in rows[0],
        str(rows),
    )
    # The drag did two things, so the row accounts for both: a row that only
    # said "join" left the page move invisible on the stack.
    check(
        "and it says the page was moved, not just that they were joined",
        "Move" in rows[0] and "position" in rows[0],
        str(rows),
    )

    order = p.eval_on_selector_all(".page-cell", "e => e.map(c => Number(c.dataset.index))")
    check("the dragged page is first", order[0] == 0, str(order))

    numbering = p.eval_on_selector_all(".page-number", "e => e.map(x => x.textContent)")
    check(
        "the page numbers read as the finished document",
        numbering == [str(i + 1) for i in range(8)],
        str(numbering),
    )

    # --- The join is undoable, like everything else --------------------------
    # Nothing is written until export, and joining is no exception: unticking
    # the row has to give back two documents, not leave one that cannot be
    # taken apart.
    p.locator(".op input[type=checkbox]").first.uncheck()
    p.wait_for_timeout(3000)
    apart = assets(p)
    check("unticking the join gives both documents back", len(apart) == 2, str(apart))
    check(
        "each with its own pages",
        [a["pages"] for a in apart] == [6, 2],
        str(apart),
    )
    check("and their headings return", p.locator(".page-group-head").count() == 2)
    check("every page is still on screen", p.locator(".page-cell").count() == 8,
          str(p.locator(".page-cell").count()))
    check("the row stays on the stack, unticked", len(ops(p)) == 1, str(ops(p)))

    p.locator(".op input[type=checkbox]").first.check()
    p.wait_for_timeout(3000)
    check("re-ticking joins them again", len(assets(p)) == 1, str(assets(p)))
    check("with no headings", p.locator(".page-group-head").count() == 0)

    # Undo proper: the row goes, and so does the document it made.
    p.click("#undo-last")
    p.wait_for_timeout(3000)
    undone = assets(p)
    check("undo takes the join off the stack", len(ops(p)) == 0, str(ops(p)))
    check("and leaves the two documents separate", len(undone) == 2, str(undone))
    check(
        "under their own names",
        [a["name"] for a in undone] == ["sample.pdf", "sensitive.pdf"],
        str(undone),
    )
    check("with no combined document left behind",
          p.locator(".page-cell").count() == 8, str(p.locator(".page-cell").count()))

    # Join them again for the rest of the suite.
    drag_page(
        p,
        ".page-group[data-asset-id=pdf_2] .page-cell",
        ".page-group[data-asset-id=pdf_1] .page-cell",
    )
    check("they can be joined again after an undo", len(assets(p)) == 1, str(assets(p)))

    # --- Joining outright does the same thing --------------------------------
    p.evaluate(
        """async () => {
        const w = await import('./src/core/workspace.js');
        for (const a of [...w.getState().assets]) w.removeAsset(a.id);
    }"""
    )
    p.wait_for_timeout(400)
    p.set_input_files("#file-input", [f"{S}/sample.pdf", f"{S}/sensitive.pdf"])
    p.wait_for_timeout(4000)
    check("two documents again", p.locator(".page-group-head").count() == 2)

    p.click(".asset-action button")
    p.wait_for_timeout(4000)
    joined = assets(p)
    check("joining leaves one document on the bench", len(joined) == 1, str(joined))
    check("with all eight pages", joined[0]["pages"] == 8, str(joined))
    check("and no headings", p.locator(".page-group-head").count() == 0)
    check(
        "the joined document can still be worked on",
        p.locator(".page-cell").count() == 8,
        str(p.locator(".page-cell").count()),
    )
    check("joining by button is recorded too", len(ops(p)) == 1, str(ops(p)))
    p.click("#undo-last")
    p.wait_for_timeout(3000)
    check("and undoes the same way", len(assets(p)) == 2, str(assets(p)))

    # --- Joins stack, and stand down together --------------------------------
    # Join two documents, then join the result to a third. Unticking the first
    # join has to stand down the second as well: the combined document it fed
    # is no longer something that was ever assembled, and leaving it on the
    # bench beside the documents it contains would show the same pages twice.
    p.evaluate(
        """async () => {
        const w = await import('./src/core/workspace.js');
        w.clearOperations();
        for (const a of [...w.getState().assets]) w.removeAsset(a.id);
    }"""
    )
    p.wait_for_timeout(400)
    p.set_input_files("#file-input", [f"{S}/sample.pdf", f"{S}/sensitive.pdf"])
    p.wait_for_timeout(4000)
    p.click(".asset-action button")
    p.wait_for_timeout(4000)
    p.set_input_files("#file-input", f"{S}/sample.pdf")
    p.wait_for_timeout(4000)
    p.click(".asset-action button")
    p.wait_for_timeout(4500)

    stacked = assets(p)
    check("two joins leave one document", len(stacked) == 1, str(stacked))
    check("holding every page of all three", stacked[0]["pages"] == 14, str(stacked))
    check("with both joins on the stack", len(ops(p)) == 2, str(ops(p)))

    p.locator(".op input[type=checkbox]").first.uncheck()
    p.wait_for_timeout(3000)
    unwound = assets(p)
    check(
        "unticking the first join stands down the second",
        len(unwound) == 3,
        str(unwound),
    )
    check(
        "and no page is on the bench twice",
        sum(a["pages"] for a in unwound) == 14
        and p.locator(".page-cell").count() == 14,
        f"{unwound} cells={p.locator('.page-cell').count()}",
    )

    p.locator(".op input[type=checkbox]").first.check()
    p.wait_for_timeout(3000)
    check("re-ticking rebuilds both", len(assets(p)) == 1, str(assets(p)))

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
