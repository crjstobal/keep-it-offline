# Keep It Offline

A file workbench that runs entirely in your browser. Redact PDFs, grade
photographs, cut video and speed up audio without uploading anything, and let an
AI agent operate the same tools without ever seeing the files themselves.

**Live demo:** _TODO before submitting: paste the deployed URL here._ It must be
the same URL given on the submission form, served over HTTPS, and opened once in
Chrome 149+ with the WebMCP flag on to confirm the tools register.

## The idea

Every online PDF tool asks you to upload your document to a stranger's server.
Payslips, contracts, medical records, passports. The file is processed remotely
and you are asked to trust a privacy policy.

Keep It Offline does the work in the tab. Your file is read into memory, edited
there, and written back out as a download. Nothing is transmitted, and the app
makes no third-party requests at all: see the section below for how to check
that rather than take it on trust.

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

## Nothing leaves the tab, and you can check

The claim is easy to make and worth verifying, so the app is built so that a
reader can confirm it rather than trust it:

- **No third-party requests at all.** pdf.js, pdf-lib and fflate are vendored
  under `assets/vendor/`, and the typeface under `assets/fonts/`. A page whose
  promise is that nothing leaves your computer should not open the tab by
  telling a CDN you are here.
- **A Content-Security-Policy that enforces it.** `connect-src 'self'` means no
  `fetch`, XHR, WebSocket or beacon can reach another host, and `form-action
  'none'` closes the other way out. If a future change ever tried to upload a
  file, the browser would block it and say so in the console. See `_headers`
  and `netlify.toml`.
- **Check it yourself.** Open DevTools, go to the Network tab, and use the app.
  Every request is to this origin, and after load there are none at all. The
  test suite asserts the same thing.

Because there is no build step, the source in this repository is exactly what
runs in the browser.

## Running locally

WebMCP requires a secure context. `localhost` counts as one.

```sh
python3 serve.py
```

Then open http://localhost:8899.

Use `serve.py` rather than `python3 -m http.server`: the built-in server lets the
browser cache modules, so an edit can sit invisible behind a stale copy. This one
sends the same no-cache policy the deployed site uses.

To enable the API in Chrome, set `chrome://flags/#enable-webmcp-testing` to
Enabled and restart. Chrome 149 or later.

The app is fully functional without WebMCP. In a browser without it, the tool
panel says so and every feature remains available by hand.

## What it does

**PDFs**: remove, rotate and reorder pages, with a thumbnail grid for doing it by
hand and an enlarged viewer for checking a page before acting on it.

**Redaction**, which is the case this app was built for. Payslips, contracts and
medical letters are exactly the documents people should never upload, and every
free tool online asks them to. Black out literal text, a pattern, or categories
of personal data (email addresses, phone numbers, IBANs, card numbers, ID
numbers, dates).

Two details matter here. Redacted pages are **flattened to images**, because a
black rectangle drawn over text hides nothing: the glyphs stay in the file and
any reader copies them straight back out. This was verified rather than assumed
by running `pdftotext` over a boxed file, which returned the "hidden" address in
full; the test suite now asserts that five kinds of personal data cannot be
extracted from an export, and that pages with nothing to redact keep their
selectable text.

And an agent can drive the whole thing **without reading the document**. It names
a pattern or a category, and what comes back is a count and a list of page
numbers, never the matched text.

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

**Audio**: change speed and trim, over a waveform so a cut can be aimed at
something visible. Speeding up shifts the pitch, the way a record played fast
sounds higher, because that is what a browser can do without a time-stretching
library; the tool says so rather than pretending otherwise.

Because tools are registered per file kind, none of this crowds the others: a
a PDF adds eight tools, images eleven, video six, audio four, on top of the two
that are always there.

## Regenerating the LUTs

Colour looks are standard `.cube` lookup tables in `assets/luts`, so any LUT
exported from Lightroom, Resolve or Photoshop can be dropped in. The five that
ship are generated:

```sh
node tools/gen-lut.mjs
```

## Tests

```sh
python3 serve.py              # the browser tests need this
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
