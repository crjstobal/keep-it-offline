import sys, os, base64, io
from playwright.sync_api import sync_playwright
from PIL import Image

S = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
passed = failed = 0
def check(n, c, extra=""):
    global passed, failed
    if c: passed += 1; print(f"  ok  {n}")
    else: failed += 1; print(f"  FAIL {n}" + (f"\n       {extra}" if extra else ""))

def run(p, ops):
    b64 = p.evaluate("""async (ops) => {
        const { getState } = await import('./src/core/workspace.js');
        const { imageCall } = await import('./src/core/worker-bridge.js');
        const { ensureLutLoaded } = await import('./src/core/luts.js');
        const asset = getState().assets[0];
        for (const op of ops) if (op.type === 'apply_lut') await ensureLutLoaded(op.params.lut_name);
        const out = await imageCall('process', {
            bytes: asset.bytes.slice(0), operations: ops, type: asset.meta.type });
        return btoa(String.fromCharCode(...new Uint8Array(out.bytes)));
    }""", ops)
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")

with sync_playwright() as pw:
    b = pw.chromium.launch()
    p = b.new_page(viewport={"width": 1400, "height": 900})
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto("http://localhost:8899/index.html")
    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(1500)

    base = run(p, [])
    bx, by = 30, 150
    orig = base.getpixel((bx, by))

    # Brightness
    brighter = run(p, [{"type":"adjust_image","params":{"brightness":0.3}}]).getpixel((bx,by))
    darker = run(p, [{"type":"adjust_image","params":{"brightness":-0.3}}]).getpixel((bx,by))
    check("brightness up lightens", sum(brighter) > sum(orig), f"{orig} -> {brighter}")
    check("brightness down darkens", sum(darker) < sum(orig), f"{orig} -> {darker}")

    # Contrast pushes a bright pixel further from mid grey.
    punchy = run(p, [{"type":"adjust_image","params":{"contrast":0.4}}]).getpixel((bx,by))
    check("contrast pushes away from mid grey",
          abs(punchy[0]-128) > abs(orig[0]-128), f"{orig} -> {punchy}")

    # Saturation
    grey = run(p, [{"type":"adjust_image","params":{"saturation":-1}}]).getpixel((bx,by))
    check("saturation -1 removes colour", max(grey)-min(grey) < 8, str(grey))
    vivid = run(p, [{"type":"adjust_image","params":{"saturation":0.5}}]).getpixel((bx,by))
    check("saturation up increases colour spread",
          (max(vivid)-min(vivid)) > (max(orig)-min(orig)), f"{orig} -> {vivid}")

    # Vibrance should move a saturated colour LESS than plain saturation does.
    vib = run(p, [{"type":"adjust_image","params":{"vibrance":0.5}}]).getpixel((bx,by))
    sat = run(p, [{"type":"adjust_image","params":{"saturation":0.5}}]).getpixel((bx,by))
    d_vib = abs((max(vib)-min(vib)) - (max(orig)-min(orig)))
    d_sat = abs((max(sat)-min(sat)) - (max(orig)-min(orig)))
    check("vibrance protects already-saturated colours", d_vib < d_sat,
          f"vibrance moved {d_vib}, saturation moved {d_sat}")

    # All four in one call must combine.
    combo = run(p, [{"type":"adjust_image","params":{"brightness":0.1,"contrast":0.2,"saturation":-0.3,"vibrance":0.1}}])
    check("four adjustments combine in one pass", combo.getpixel((bx,by)) != orig)

    # Vignette darkens corners but not the middle.
    vig = run(p, [{"type":"apply_vignette","params":{"amount":0.8}}])
    corner_before = base.getpixel((5,5)); corner_after = vig.getpixel((5,5))
    mid_before = base.getpixel((200,150)); mid_after = vig.getpixel((200,150))
    check("vignette darkens the corners", sum(corner_after) < sum(corner_before),
          f"{corner_before} -> {corner_after}")
    check("vignette leaves the centre nearly alone",
          abs(sum(mid_after) - sum(mid_before)) < 40, f"{mid_before} -> {mid_after}")

    # Watermark draws pixels in the requested corner and not the opposite one.
    wm = run(p, [{"type":"add_watermark","params":{"text":"KEEP IT OFFLINE","position":"bottom-right","opacity":1,"size":0.08}}])
    br_changed = sum(1 for x in range(300,400) for y in range(250,300)
                     if wm.getpixel((x,y)) != base.getpixel((x,y)))
    tl_changed = sum(1 for x in range(0,100) for y in range(0,50)
                     if wm.getpixel((x,y)) != base.getpixel((x,y)))
    check("watermark draws in the requested corner", br_changed > 50, f"{br_changed} px changed")
    check("watermark leaves the opposite corner alone", tl_changed == 0, f"{tl_changed} px changed")

    wm2 = run(p, [{"type":"add_watermark","params":{"text":"TEST","position":"top-left","opacity":1,"size":0.08}}])
    tl2 = sum(1 for x in range(0,150) for y in range(0,60)
              if wm2.getpixel((x,y)) != base.getpixel((x,y)))
    check("watermark position is honoured", tl2 > 50, f"{tl2} px changed top-left")

    # A LUT and adjustments must stack rather than one replacing the other.
    stacked = run(p, [
        {"type":"apply_lut","params":{"lut_name":"black-and-white","intensity":1}},
        {"type":"adjust_image","params":{"brightness":0.2}},
    ]).getpixel((bx,by))
    lut_only = run(p, [{"type":"apply_lut","params":{"lut_name":"black-and-white","intensity":1}}]).getpixel((bx,by))
    check("a LUT and adjustments stack together",
          max(stacked)-min(stacked) < 8 and sum(stacked) > sum(lut_only),
          f"lut={lut_only} stacked={stacked}")

    check("no errors", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
