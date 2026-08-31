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

    # Stand in for the WebMCP API so the dynamic registration can be observed
    # in a browser that does not ship it.
    p.add_init_script("""
      window.__registered = new Set();
      document.modelContext = {
        registerTool: (def, opts) => {
          window.__registered.add(def.name);
          opts?.signal?.addEventListener('abort', () => window.__registered.delete(def.name));
          return Promise.resolve();
        }
      };
    """)
    p.goto("http://localhost:8899/index.html")
    p.wait_for_timeout(600)

    def tools():
        return sorted(p.evaluate("() => [...window.__registered]"))

    empty = tools()
    check("empty bench registers only workspace tools",
          set(empty) == {"describe_workspace", "undo_operation"}, str(empty))

    p.set_input_files("#file-input", f"{S}/sample.pdf")
    p.wait_for_timeout(1500)
    with_pdf = tools()
    check("loading a PDF registers the PDF tools",
          {"describe_pdf", "remove_pages", "rotate_pages"} <= set(with_pdf), str(with_pdf))
    check("image tools stay unregistered with no images",
          not {"apply_look", "resize_images"} & set(with_pdf), str(with_pdf))

    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(1200)
    both = tools()
    check("adding an image registers the image tools",
          {"apply_look", "resize_images", "convert_images", "list_looks"} <= set(both), str(both))
    check("PDF tools remain while a PDF is loaded",
          {"describe_pdf", "remove_pages"} <= set(both), str(both))

    # Removing the PDF must deregister its tools via AbortController.
    p.locator(".asset").first.locator("button").click()
    p.wait_for_timeout(800)
    after = tools()
    check("removing the PDF deregisters the PDF tools",
          not {"describe_pdf", "remove_pages", "rotate_pages"} & set(after), str(after))
    check("image tools survive removing the PDF",
          {"apply_look", "resize_images"} <= set(after), str(after))

    # The point of dynamic registration is that the choice stays small. A mixed
    # bench is the widest case; single-kind benches are smaller still. Fifteen is
    # the ceiling: past that an agent starts picking the wrong tool.
    check("a mixed bench stays within the tool budget", len(both) <= 15, f"{len(both)}: {both}")

    # A bench holding only images must not offer PDF tools, and vice versa. This
    # is what keeps the catalogue from being paid for on every request.
    only_pdf = [t for t in with_pdf if t not in ("describe_workspace", "undo_operation", "apply_and_export")]
    check("a PDF-only bench stays small", len(only_pdf) <= 8, f"{len(only_pdf)}: {only_pdf}")
    only_images = tools()
    check("a single-kind bench is smaller than a mixed one",
          len(only_images) < len(both), f"{len(only_images)} vs {len(both)}")
    check("no errors", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
