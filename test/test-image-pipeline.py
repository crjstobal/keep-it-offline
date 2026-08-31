import sys, base64, io
from playwright.sync_api import sync_playwright
from PIL import Image

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
    p.set_input_files("#file-input", f"{S}/bars.png")
    p.wait_for_timeout(1200)

    check("image loaded onto the bench", p.locator(".asset").count() == 1)
    detail = p.inner_text(".asset-detail")
    check("dimensions read correctly", "400×300" in detail, detail)
    check("no errors on image load", not errors, "; ".join(errors[:3]))

    # Drive the worker directly, the way the tools do, and inspect the output.
    result = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { imageCall } = await import('./src/core/worker-bridge.js');
        const { ensureLutLoaded, availableLuts } = await import('./src/core/luts.js');
        const asset = getState().assets[0];
        await ensureLutLoaded('black-and-white');
        const out = await imageCall('process', {
            bytes: asset.bytes.slice(0),
            operations: [{type:'apply_lut', params:{lut_name:'black-and-white', intensity:1}}],
            type: asset.meta.type,
        });
        const b64 = btoa(String.fromCharCode(...new Uint8Array(out.bytes)));
        return {b64, width: out.width, height: out.height, type: out.type,
                looks: availableLuts().map(l => l.name)};
    }""")

    check("list_looks exposes the shipped LUT", "black-and-white" in result["looks"], str(result["looks"]))
    check("output keeps its dimensions", (result["width"], result["height"]) == (400, 300),
          f"{result['width']}x{result['height']}")

    img = Image.open(io.BytesIO(base64.b64decode(result["b64"]))).convert("RGB")
    px = [img.getpixel((x, 150)) for x in (30, 100, 170, 240, 310, 370)]
    greys = all(abs(r-g) <= 3 and abs(g-bl) <= 3 for r, g, bl in px)
    check("every colour bar came out neutral grey", greys, str(px))

    # Distinct colours must still map to distinct greys, or the look is useless.
    lums = sorted({round(sum(c)/3) for c in px})
    check("bars remain distinguishable after grading", len(lums) >= 4, str(lums))

    # Half intensity must sit between the original and the full conversion.
    half = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { imageCall } = await import('./src/core/worker-bridge.js');
        const asset = getState().assets[0];
        const out = await imageCall('process', {
            bytes: asset.bytes.slice(0),
            operations: [{type:'apply_lut', params:{lut_name:'black-and-white', intensity:0.5}}],
            type: asset.meta.type,
        });
        return btoa(String.fromCharCode(...new Uint8Array(out.bytes)));
    }""")
    himg = Image.open(io.BytesIO(base64.b64decode(half))).convert("RGB")
    hr, hg, hb = himg.getpixel((30, 150))
    check("half intensity keeps some colour", abs(hr - hg) > 10, f"{(hr,hg,hb)}")

    # Resize and format conversion.
    conv = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { imageCall } = await import('./src/core/worker-bridge.js');
        const asset = getState().assets[0];
        const out = await imageCall('process', {
            bytes: asset.bytes.slice(0),
            operations: [
              {type:'resize_images', params:{max_width:200}},
              {type:'convert_format', params:{format:'webp', quality:0.8}},
            ],
            type: asset.meta.type,
        });
        return {w: out.width, h: out.height, type: out.type, size: out.size};
    }""")
    check("resize honours the box and keeps the ratio", (conv["w"], conv["h"]) == (200, 150),
          f"{conv['w']}x{conv['h']}")
    check("format conversion produces webp", conv["type"] == "image/webp", conv["type"])

    # Upscaling must not happen.
    up = p.evaluate("""async () => {
        const { getState } = await import('./src/core/workspace.js');
        const { imageCall } = await import('./src/core/worker-bridge.js');
        const asset = getState().assets[0];
        const out = await imageCall('process', {
            bytes: asset.bytes.slice(0),
            operations: [{type:'resize_images', params:{max_width:5000}}],
            type: asset.meta.type,
        });
        return [out.width, out.height];
    }""")
    check("a smaller image is not enlarged", up == [400, 300], str(up))

    check("no errors during image work", not errors, "; ".join(errors[:3]))
    b.close()

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
