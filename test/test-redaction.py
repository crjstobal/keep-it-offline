import sys, os, subprocess
from playwright.sync_api import sync_playwright

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

def text_of(path):
    out = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, timeout=30)
    return out.stdout

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")
    p.set_input_files("#file-input", f"{S}/sensitive.pdf")
    p.wait_for_timeout(3000)

    # Finding must report counts and pages, never the text itself.
    found = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { findMatches } = await import('./src/core/redact.js');
        const a = getState().assets[0];
        const r = await findMatches(a.bytes, { categories: ['email'] });
        return { total: r.total, pages: r.pages.map(x => x.page) };
    }""")
    check("an email address is found", found["total"] >= 1, str(found))
    check("it is located on page one", found["pages"] == [1], str(found["pages"]))

    counts = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { findMatches } = await import('./src/core/redact.js');
        const a = getState().assets[0];
        const out = {};
        for (const c of ['email','phone','iban','card','id_number','date']) {
            out[c] = (await findMatches(a.bytes, { categories: [c] })).total;
        }
        return out;
    }""")
    for category in ("email", "phone", "iban", "card", "id_number"):
        check(f"the {category} pattern matches", counts[category] >= 1, str(counts))

    # Redact every category, then export and inspect the result.
    p.evaluate("""async () => {
        const { getState, pushOperation } = await import('./src/core/workspace.js');
        const { findMatches, rasterisePages } = await import('./src/core/redact.js');
        const a = getState().assets[0];
        const cats = ['email','phone','iban','card','id_number'];
        const { pages, total } = await findMatches(a.bytes, { categories: cats });
        const rendered = await rasterisePages(a.bytes, pages);
        pushOperation({ type: 'redact', assetIds: a.id,
            params: { rendered, pages: pages.map(x => x.page) },
            summary: `Redact ${total} matches`, source: 'agent' });
    }""")
    p.wait_for_timeout(1500)
    check("redaction queues an operation", p.locator(".op").count() == 1)

    with p.expect_download(timeout=60000) as dl:
        p.click("#export-btn")
    out_path = "/tmp/redacted-out.pdf"
    dl.value.save_as(out_path)

    extracted = text_of(out_path)

    # The whole point: the covered text must be gone, not merely hidden.
    for label, secret in [
        ("email address", "alex.fernandez@example.com"),
        ("phone number", "612 345 678"),
        ("ID number", "12345678Z"),
        ("IBAN", "ES91 2100 0418 4502"),
        ("card number", "4111 1111 1111 1111"),
    ]:
        check(f"the {label} cannot be extracted from the export",
              secret not in extracted, f"found: {secret!r}")

    # A page with nothing to redact must keep its text intact.
    check("an untouched page keeps its selectable text",
          "Page two" in extracted, extracted[:200])

    # And the document must still be a valid, complete PDF.
    pages_out = subprocess.run(
        ["pdfinfo", out_path], capture_output=True, text=True, timeout=20).stdout
    check("the export is a valid PDF with both pages", "Pages:           2" in pages_out,
          [l for l in pages_out.splitlines() if "Pages" in l])

    # --- The user has to be able to see it -----------------------------------
    # A redaction that only exists in the downloaded file asks the user to trust
    # a change they were never shown. The grid must black the page out too, and
    # unticking the operation must put the original back.
    p.evaluate("""async () => {
        const { clearOperations } = await import('./src/core/workspace.js');
        clearOperations();
    }""")
    p.wait_for_timeout(600)
    check("clearing puts the pages back", p.locator(".page-cell.is-redacted").count() == 0)

    # --- Blacking out by hand ------------------------------------------------
    # The agent has had a tool for this all along. A person needs the same thing,
    # pushing the same operation, or the feature does not exist without an agent.
    p.click("#black-out-toggle")
    p.check(".blackout-cats input[value=email]")
    p.click("#black-out-count")
    p.wait_for_timeout(2500)
    counted = p.text_content("#black-out-status")
    check("counting reports matches without changing anything",
          "match" in counted and p.locator(".op").count() == 0, counted)

    p.click("#black-out-apply")
    p.wait_for_timeout(5000)
    check("blacking out by hand queues an operation", p.locator(".op").count() == 1,
          p.text_content("#black-out-status"))
    check("it is tagged as the user's, not the agent's",
          p.locator(".badge-user").count() == 1)
    check("the redacted page is blacked out on screen",
          p.locator(".page-cell.is-redacted").count() == 1,
          str(p.locator(".page-cell.is-redacted").count()))
    check("the page with nothing on it is left alone",
          p.locator(".page-cell").count() == 2
          and p.locator(".page-cell.is-redacted").count() == 1)

    # Unticking has to reverse what is on screen, the same as every other change.
    p.locator(".op input[type=checkbox]").last.uncheck()
    p.wait_for_timeout(800)
    check("unticking the operation restores the original page",
          p.locator(".page-cell.is-redacted").count() == 0)
    p.locator(".op input[type=checkbox]").last.check()
    p.wait_for_timeout(800)
    check("and ticking it blacks the page out again",
          p.locator(".page-cell.is-redacted").count() == 1)

    # Enlarging a redacted page must not put the hidden text back on screen.
    p.locator(".page-cell.is-redacted").first.hover()
    p.locator(".page-cell.is-redacted").first.locator(".page-zoom").click()
    p.wait_for_timeout(2500)
    shown = p.evaluate("() => document.querySelector('.viewer img')?.src ?? ''")
    check("the enlarged view shows the redacted render, not the original",
          shown.startswith("data:image/"), shown[:60])

    check("no errors throughout", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
