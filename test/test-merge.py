# Joining documents that have already been edited.
#
# A join bakes each half's queued changes into new bytes, which is what makes
# the combined document something you can keep working on. Three things went
# wrong with that and are pinned here:
#
#   1. The combined document had no operations of its own, so the agent's
#      apply_and_export refused it as "nothing to apply" even though the user
#      could export it perfectly well with the button.
#   2. Unticking a redaction that happened before the join changed nothing: the
#      black bars stayed burned into the combined bytes, so the row claimed to
#      be reversible and was not.
#   3. "Merge and download" merged and downloaded nothing, because merging is
#      deliberately not an export and no tool did both.

import os, re, subprocess, sys
from playwright.sync_api import sync_playwright

passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

OUT = os.environ.get("TMPDIR", "/tmp")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")

def emails_in(path):
    out = subprocess.run(["pdftotext", path, "-"], capture_output=True, text=True, timeout=30)
    return sorted(set(EMAIL.findall(out.stdout)))

def pages_in(path):
    import pypdf
    return len(pypdf.PdfReader(path).pages)

SHIM = """
window.__tools = new Map();
document.modelContext = { registerTool: async (d, o) => {
  window.__tools.set(d.name, d);
  o?.signal?.addEventListener('abort', () => window.__tools.delete(d.name));
}};
"""

PICK_SECOND_PDF = """async () => {
  const { setSelection, listAssets } = await import('./src/core/workspace.js');
  setSelection([listAssets('pdf')[1].id], 'pdf');
}"""

CATS = ["email", "phone", "iban", "card", "id_number"]

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 950}, accept_downloads=True)
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.add_init_script(SHIM)

    p.goto("http://localhost:8899/index.html")
    p.wait_for_timeout(1200)
    p.click(".demo-button"); p.wait_for_timeout(300)
    p.click(".demo-item:has-text('A report in two parts')")
    p.wait_for_timeout(6000)

    call = lambda n, a: p.evaluate(
        "async ([n,a]) => await window.__tools.get(n).execute(a)", [n, a])

    # Redact BOTH halves, then join them.
    for fid in ["pdf_1", "pdf_2"]:
        call("redact_pdf", {"categories": CATS, "file_id": fid})
    p.wait_for_timeout(2500)
    check("both documents have a redaction queued",
          p.locator(".op-summary").count() == 2)

    call("merge_pdfs", {})
    p.wait_for_timeout(9000)

    bench = p.evaluate("""async () => {
        const { listAssets } = await import('./src/core/workspace.js');
        return listAssets().map(a => ({ id: a.id, name: a.name, pages: a.meta.pageCount }));
    }""")
    check("the join leaves one document on the bench", len(bench) == 1, str(bench))
    check("and it has every page of both halves",
          bench[0]["pages"] == 18, str(bench))

    merged_id = bench[0]["id"]

    # 1. The agent can export a joined document, whose changes are in its bytes.
    reply = call("apply_and_export", {"file_id": merged_id})
    check("the agent can export a joined document",
          "nothing to apply" not in reply.lower(), reply)
    p.wait_for_timeout(1500)

    # 2. The redaction holds in the exported file, for BOTH halves.
    with p.expect_download(timeout=60000) as dl:
        p.click("#export-btn")
    on = os.path.join(OUT, "merge-redacted.pdf")
    dl.value.save_as(on)
    check("the joined export has all 18 pages", pages_in(on) == 18)
    check("no email survives in the joined export", emails_in(on) == [],
          str(emails_in(on)))

    # 3. Unticking a redaction rebuilds the joined document, so the row is
    #    telling the truth about what is on screen.
    p.locator(".op input[type=checkbox]").nth(0).uncheck()
    p.wait_for_timeout(4000)
    p.locator(".op input[type=checkbox]").nth(1).uncheck()
    p.wait_for_timeout(6000)

    with p.expect_download(timeout=60000) as dl2:
        p.click("#export-btn")
    off = os.path.join(OUT, "merge-unredacted.pdf")
    dl2.value.save_as(off)
    back = emails_in(off)
    check("unticking both redactions brings the text back", len(back) == 2, str(back))
    check("and it comes back from both halves of the join",
          len({e.split("@")[1] for e in back}) == 2, str(back))

    b.close()

with sync_playwright() as pw:
    # A fresh page: "merge and download" as one instruction.
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 950}, accept_downloads=True)
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.add_init_script(SHIM)
    p.goto("http://localhost:8899/index.html")
    p.wait_for_timeout(1200)
    p.click(".demo-button"); p.wait_for_timeout(300)
    p.click(".demo-item:has-text('A report in two parts')")
    p.wait_for_timeout(6000)

    call = lambda n, a: p.evaluate(
        "async ([n,a]) => await window.__tools.get(n).execute(a)", [n, a])
    for fid in ["pdf_1", "pdf_2"]:
        call("redact_pdf", {"categories": CATS, "file_id": fid})
    p.wait_for_timeout(2500)

    got = {}
    with p.expect_download(timeout=90000) as dl:
        got["reply"] = call("merge_pdfs", {"download": True})
    saved = os.path.join(OUT, "merge-and-download.pdf")
    dl.value.save_as(saved)
    check("merge with download: true hands over a file", os.path.exists(saved))
    check("the downloaded file is the joined document", pages_in(saved) == 18)
    check("and it is redacted", emails_in(saved) == [], str(emails_in(saved)))
    check("the reply says a download is coming",
          "download" in got["reply"].lower(), got["reply"])

    # Without the flag the join stays on the bench, as designed.
    b.close()

with sync_playwright() as pw:
    # Blacking out by hand with two documents on the bench.
    #
    # The panel used to insist on a ticked *page*, so with two PDFs loaded and a
    # document picked out it still refused to do anything: picking files is how
    # every other control is narrowed, and this one ignored it.
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1600, "height": 1000})
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto("http://localhost:8899/index.html")
    p.wait_for_timeout(1200)
    p.click(".demo-button"); p.wait_for_timeout(300)
    p.click(".demo-item:has-text('A report in two parts')")
    p.wait_for_timeout(6000)

    p.click("#black-out-toggle"); p.wait_for_timeout(400)
    p.check(".blackout-cats input[value=email]")
    p.wait_for_timeout(300)

    # With two documents and nothing picked there is no honest answer, so it
    # says so rather than redacting one the user was not looking at.
    p.click("#black-out-apply")
    p.wait_for_timeout(2000)
    said = p.text_content("#black-out-status")
    check("with two documents and nothing picked it asks which one",
          p.locator(".op").count() == 0 and "pick" in said.lower(), said)

    # Picking one is enough: no page tick required.
    p.evaluate(PICK_SECOND_PDF)
    p.wait_for_timeout(1000)
    p.click("#black-out-apply")
    p.wait_for_timeout(5000)
    check("picking a document is enough to black out in it",
          p.locator(".op").count() == 1, p.text_content("#black-out-status"))
    check("and the row is tagged as the user's",
          p.locator(".badge-user").count() == 1)

    b.close()

check("no page errors throughout", not errors, "; ".join(errors[:3]))
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
