# Keep It Offline

A file workbench that runs entirely in your browser. Edit PDFs, grade photographs
and cut video without uploading anything, and let an AI agent operate the same
tools without ever seeing the files themselves.

**Live demo:** https://keepitoffline.com

## The idea

Every online PDF tool asks you to upload your document to a stranger's server.
Payslips, contracts, medical records, passports. The file is processed remotely
and you are asked to trust a privacy policy.

Keep It Offline does the work in the tab. Your file is read into memory, edited
there, and written back out as a download. Nothing is transmitted. The counter in
the header shows the bytes uploaded by this app, and it stays at zero.

WebMCP is what makes the second half possible. An agent can drive the workbench
through registered tools, but the tools return *facts about* the document, never
its contents. The agent supplies the intent ("drop the blank pages", "redact
every email address") and the page supplies the data. The two never mix.

That separation is not a policy. It is the architecture, and it is not something
a server-side tool can offer.

## How WebMCP is used

Tools are registered with the browser's model context:

```js
document.modelContext.registerTool({
  name: "remove_pages",
  description: "Queue removal of the given pages from a PDF.",
  inputSchema: { /* ... */ },
  execute: async ({ pages }) => { /* ... */ }
});
```

Three things make this more than a remote control for buttons:

**Tools are registered dynamically.** The registered set tracks what is actually
on the bench. With nothing loaded, an agent sees two tools. Load a PDF and the PDF
tools appear; remove it and they are deregistered via `AbortController`. The tool
list is a live description of page state, not a static API surface. The side panel
shows this happening.

**Nothing an agent does is destructive.** Tools push onto a visible operation
stack instead of mutating bytes. The user sees each step appear, tagged with who
added it, and can disable any of them with a checkbox. Only `apply_and_export`
produces a file. A wrong call from the agent costs one click to undo.

**The heavy work runs off the main thread.** WebMCP tools execute on the main
thread, so a batch job would freeze the page. Tools acknowledge immediately and
hand the work to a Web Worker, which means the user can keep working while an
agent processes a batch, and both see the same state change live.

## Running locally

WebMCP requires a secure context. `localhost` counts as one.

```sh
python3 -m http.server 8899
```

Then open http://localhost:8899.

To enable the API in Chrome, set `chrome://flags/#enable-webmcp-testing` to
Enabled and restart. Chrome 149 or later.

The app is fully functional without WebMCP. In a browser without it, the tool
panel says so and every feature remains available by hand.

## What it does

**PDFs**: remove, rotate and reorder pages, with a thumbnail grid for doing it by
hand and an enlarged viewer for checking a page before acting on it.

**Images**: rotate, resize to fit a box, convert between WebP, JPEG and PNG,
adjust brightness, contrast, saturation and vibrance, add a vignette or a
positioned watermark, and apply colour looks. Grading a batch is where an agent
earns its keep: "give these forty photographs a warm look and export them at
2000px as WebP" is three tool calls, and the agent never sees a single pixel.

**Video**: trim, rotate, resize, and grade with the same looks as the stills.
This needs no ffmpeg build. The browser already ships a decoder and an H.264
encoder, so a `<video>` element decodes, a canvas does the per-frame work, and
MediaRecorder encodes the result, which keeps the whole app a few hundred
kilobytes rather than thirty megabytes.

Rotation is worth calling out. Asking for a *shape* rather than a *turn* is the
useful version: "make these all portrait" rotates only the clips that are not
already portrait and leaves the rest alone, for stills and footage alike.

## Regenerating the LUTs

Colour looks are standard `.cube` lookup tables in `assets/luts`, so any LUT
exported from Lightroom, Resolve or Photoshop can be dropped in. The five that
ship are generated:

```sh
node tools/gen-lut.mjs
```

## Tests

```sh
python3 -m http.server 8899   # the browser tests need this
cd test && npm install && node run-all.mjs
```

Five Node suites cover the operation stack, the LUT parser and colour sampling,
the agreement between the on-screen preview and the exported PDF, and the video
geometry planner. Seven Playwright suites drive the real page: the page grid and
its geometry, dynamic tool registration and deregistration across all three file
kinds, the image pipeline and the adjustments (both checking the actual pixels
that come out), live previewing, and video end to end, including exporting a
clip and confirming with ffprobe that a one-second trim really lasts one second.

Around two hundred checks in total.

## Licence

MIT. See [LICENSE](LICENSE).
