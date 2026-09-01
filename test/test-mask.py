import sys, os, base64, io
from playwright.sync_api import sync_playwright
from PIL import Image

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1500, "height": 950})
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    p.goto("http://localhost:8899/index.html")
    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(2500)

    def run(ops):
        r = p.evaluate("""async (ops) => {
            const { getState } = await import('./src/core/workspace.js');
            const { imageCall } = await import('./src/core/worker-bridge.js');
            const a = getState().assets[0];
            const out = await imageCall('process', {bytes: a.bytes.slice(0), operations: ops, type: a.meta.type});
            return {b64: btoa(String.fromCharCode(...new Uint8Array(out.bytes))), type: out.type};
        }""", ops)
        return Image.open(io.BytesIO(base64.b64decode(r["b64"]))).convert("RGBA"), r["type"]

    # A circle keeps the middle and cuts the corners.
    img, kind = run([{"type":"apply_mask","params":{"shape":"circle","x":0.5,"y":0.5,"size":0.4}}])
    check("a masked export is PNG, which can hold transparency", kind == "image/png", kind)
    check("the centre of a circle mask is kept",
          img.getpixel((img.width//2, img.height//2))[3] == 255)
    check("the corners are cut away", img.getpixel((3, 3))[3] == 0,
          str(img.getpixel((3,3))))

    # Moving the mask moves what survives.
    left, _ = run([{"type":"apply_mask","params":{"shape":"circle","x":0.2,"y":0.5,"size":0.25}}])
    check("the mask can be moved off centre",
          left.getpixel((int(left.width*0.2), left.height//2))[3] == 255
          and left.getpixel((int(left.width*0.85), left.height//2))[3] == 0)

    # Size matters.
    small, _ = run([{"type":"apply_mask","params":{"shape":"circle","size":0.1}}])
    big, _ = run([{"type":"apply_mask","params":{"shape":"circle","size":0.5}}])
    count = lambda im: sum(1 for x in range(0, im.width, 3) for y in range(0, im.height, 3)
                           if im.getpixel((x, y))[3] > 0)
    check("a bigger mask keeps more of the image", count(big) > count(small) * 2,
          f"{count(small)} vs {count(big)}")

    # Blobs: seeded, so reshuffling means something and repeating is reliable.
    b1, _ = run([{"type":"apply_mask","params":{"shape":"blob","seed":7,"size":0.4}}])
    b2, _ = run([{"type":"apply_mask","params":{"shape":"blob","seed":8,"size":0.4}}])
    b1again, _ = run([{"type":"apply_mask","params":{"shape":"blob","seed":7,"size":0.4}}])
    differing = sum(1 for x in range(0, b1.width, 4) for y in range(0, b1.height, 4)
                    if (b1.getpixel((x,y))[3] > 0) != (b2.getpixel((x,y))[3] > 0))
    identical = all(b1.getpixel((x,y))[3] == b1again.getpixel((x,y))[3]
                    for x in range(0, b1.width, 4) for y in range(0, b1.height, 4))
    check("different seeds give different blobs", differing > 20, f"{differing} pixels differ")
    check("the same seed always gives the same blob", identical)
    check("a blob is not a circle",
          sum(1 for x in range(0, b1.width, 4) for y in range(0, b1.height, 4)
              if (b1.getpixel((x,y))[3] > 0) != (img.getpixel((x,y))[3] > 0)) > 20)

    # A square is a square.
    sq, _ = run([{"type":"apply_mask","params":{"shape":"square","size":0.3}}])
    cx, cy = sq.width//2, sq.height//2
    r = int(0.3 * min(sq.width, sq.height))
    check("a square mask keeps its corners",
          sq.getpixel((cx - r + 3, cy - r + 3))[3] == 255, "corner of the square was cut")

    # A border draws inside the kept area.
    plain, _ = run([{"type":"apply_mask","params":{"shape":"circle","size":0.4}}])
    bordered, _ = run([{"type":"apply_mask","params":{"shape":"circle","size":0.4,
                        "border_width":3,"border_color":"#ff0000"}}])
    reds = sum(1 for x in range(0, bordered.width, 2) for y in range(0, bordered.height, 2)
               if bordered.getpixel((x,y))[3] > 0 and bordered.getpixel((x,y))[0] > 200
               and bordered.getpixel((x,y))[1] < 60)
    check("a border is drawn in the chosen colour", reds > 30, f"{reds} red pixels")

    # JPEG alongside a mask must not silently fill the cut-out.
    _, forced = run([{"type":"apply_mask","params":{"shape":"circle"}},
                     {"type":"convert_format","params":{"format":"jpeg"}}])
    check("choosing JPEG with a mask falls back to PNG", forced == "image/png", forced)

    # And the controls exist and queue one operation.
    p.select_option("#mask-shape", "blob")
    p.wait_for_timeout(2000)
    check("choosing a shape enables Apply", not p.locator("#apply-mask").is_disabled())
    check("a blob offers a reshuffle", p.locator("#reshuffle-blob").is_visible())
    p.click("#apply-mask")
    p.wait_for_timeout(800)
    check("applying a mask queues one operation", p.locator(".op").count() == 1,
          f"{p.locator('.op').count()} ops")

    # A preview that overflows its frame is clipped, and a centred mask then
    # looks off-centre. Every shape of photograph has to letterbox, not crop.
    p.evaluate("""async () => {
        const { getState, removeAsset } = await import('./src/core/workspace.js');
        for (const a of [...getState().assets]) removeAsset(a.id);
    }""")
    p.wait_for_timeout(500)
    demo = os.path.join(os.path.dirname(os.path.dirname(S)), "demo-assets")
    p.set_input_files("#file-input", [os.path.join(demo, "photo-cafe.jpg"),
                                      os.path.join(demo, "photo-desk.jpg"),
                                      os.path.join(demo, "photo-market.jpg")])
    p.wait_for_selector("#mask-shape", timeout=20000)
    p.wait_for_timeout(4000)
    p.select_option("#mask-shape", "circle")
    p.wait_for_timeout(3500)

    layout = p.evaluate("""() => [...document.querySelectorAll('.image-cell')].map(c => {
        const f = c.querySelector('.image-frame').getBoundingClientRect();
        const i = c.querySelector('img').getBoundingClientRect();
        return {name: c.querySelector('.image-name').textContent,
                fits: i.width <= f.width + 1 && i.height <= f.height + 1};
    })""")
    check("previews of every shape fit inside their frame",
          layout and all(x["fits"] for x in layout),
          str([x for x in layout if not x["fits"]]))

    check("no errors", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
