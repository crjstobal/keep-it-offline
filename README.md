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

Four things make this more than a remote control for buttons:

**Tools are registered dynamically.** The registered set tracks what is actually
on the bench. With nothing loaded, an agent sees two tools. Load a PDF and the PDF
tools appear; load a second file and `select_files` joins them, because only now
is there a choice to narrow; remove them and they are deregistered via
`AbortController`. 29 tools are declared and the count runs 2 → 10 → 11 → 21 → 29
as files arrive.
The tool list is a live description of page state, not a static API surface, and
the side panel shows it happening.

**Nothing an agent does is destructive.** Tools push onto a visible operation
stack instead of mutating bytes. The user sees each step appear, tagged with who
added it, and can disable any of them with a checkbox. Only `apply_and_export`
produces a file. A wrong call from the agent costs one click to undo.

**The agent and the interface share one state.** The file list, the operation
stack and the selection all live in `src/core/workspace.js`, and both halves read
and write the same thing. Clicking two photographs narrows the controls to them;
`select_files` does the same from the agent's side, and each can see and overrule
the other's choice before anything is applied.

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
hand and an enlarged viewer for checking a page before acting on it. Every open
document is on the grid at once, each under its own heading and colour, so two
files read as two files. Drag a page from one into another and they become a
single document: the distinction was a description of the bench, not a rule, and
it goes away the moment it stops being true. Joining is itself a queued change,
so it appears on the stack and unticking it gives the separate documents back,
each with its own edits intact.

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

The redaction is **visible before it is committed**. The blacked-out page appears
in the grid and in the enlarged viewer as the flattened image it will become, and
unticking the operation puts the original back: nothing about a redaction has to
be taken on trust until the file downloads.

And an agent can drive the whole thing **without reading the document**. It names
a pattern or a category, and what comes back is a count and a list of page
numbers, never the matched text. The same operation is available by hand, from
the same panel that reports how many matches there are before anything changes.

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
PDF adds eight tools, images eleven, video six, audio four. Two workspace tools
are always registered, and two more appear when they become meaningful:
`apply_and_export` once there is a file to export, and `select_files` once there
are two files, since narrowing to one of one means nothing.

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

Five Node suites cover the operation stack, the selection model, the LUT parser
and colour sampling, the agreement between the on-screen preview and the exported
PDF, and the video geometry planner. Twelve Playwright suites drive the real
page: the page grid and its geometry, dynamic tool registration and
deregistration across all four file kinds, the image pipeline and the adjustments
(both checking the actual pixels that come out), live previewing, masking,
redaction (asserting with a real PDF text extractor that redacted data cannot be
recovered), picking files out by hand, and video and audio end to end, including
exporting a clip and confirming with ffprobe that a one-second trim really lasts
one second. One suite watches every network request from load to export and fails
if any of them leaves this origin.

440 checks across 19 suites.

## Licence

MIT. See [LICENSE](LICENSE).
