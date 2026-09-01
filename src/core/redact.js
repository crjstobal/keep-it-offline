// Finding text to redact.
//
// Redaction is the reason this app exists. Payslips, contracts, medical letters:
// the documents people most need to black out are exactly the ones they should
// never upload, and every free tool online asks them to.
//
// The important part is that an agent can drive this without reading anything.
// It supplies a pattern or a category ("every email address"), the page finds
// the matches, and what comes back is a count and a list of page numbers. The
// text itself never reaches the model.

import * as pdfjs from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

/**
 * Categories of personal data, as patterns.
 *
 * These are deliberately a little greedy: over-redacting costs the user a
 * second look, under-redacting leaks the thing they were trying to hide.
 */
export const PII_PATTERNS = {
  email: {
    label: 'email addresses',
    regex: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  },
  phone: {
    label: 'phone numbers',
    // Long enough runs of digits, spaces, dashes and brackets to be a number.
    regex: /(?:\+\d{1,3}[\s-]?)?(?:\(\d{1,4}\)[\s-]?)?\d(?:[\d\s-]{7,15})\d/g,
  },
  iban: {
    label: 'IBANs',
    regex: /\b[A-Z]{2}\d{2}[\s]?(?:[A-Z0-9]{4}[\s]?){2,7}[A-Z0-9]{1,4}\b/g,
  },
  card: {
    label: 'card numbers',
    regex: /\b(?:\d[ -]?){13,19}\b/g,
  },
  id_number: {
    label: 'ID numbers',
    // Spanish DNI/NIE and similar letter-and-digits identifiers.
    regex: /\b(?:[XYZ]?\d{7,8}[A-Z]|[A-Z]\d{7,8})\b/g,
  },
  date: {
    label: 'dates',
    regex: /\b\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}\b/g,
  },
};

/**
 * A text item's box on the page, in PDF user space.
 *
 * pdf.js reports a transform matrix whose last two entries are the origin, and
 * the y it gives is the text baseline, so the box is grown downwards a little
 * to cover descenders.
 */
function boxFor(item) {
  const [, , , , x, y] = item.transform;
  const height = item.height || Math.abs(item.transform[3]) || 10;
  const descender = height * 0.25;
  return {
    x,
    y: y - descender,
    width: item.width,
    height: height + descender,
  };
}

/**
 * Find matches for a set of patterns, page by page.
 *
 * Returns boxes to cover and a count, never the matched text: the caller is
 * often an agent, and handing it the very strings the user wanted hidden would
 * defeat the point.
 *
 * @param {ArrayBuffer} bytes
 * @param {Object} spec
 * @param {string} [spec.text]          Literal text to find.
 * @param {string} [spec.pattern]       Regular expression source.
 * @param {string[]} [spec.categories]  Keys of PII_PATTERNS.
 * @param {boolean} [spec.caseSensitive]
 */
export async function findMatches(bytes, spec) {
  const regexes = buildRegexes(spec);
  if (regexes.length === 0) throw new Error('Nothing to search for.');

  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const perPage = [];
  let total = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const boxes = [];

    for (const item of content.items) {
      if (!item.str) continue;

      for (const { regex } of regexes) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(item.str)) !== null) {
          // A zero-length match would loop forever.
          if (match[0].length === 0) {
            regex.lastIndex++;
            continue;
          }
          boxes.push(sliceBox(item, match.index, match[0].length));
          total++;
        }
      }
    }

    if (boxes.length > 0) {
      perPage.push({ page: pageNumber, boxes, height: viewport.height });
    }
  }

  return { total, pages: perPage, pageCount: doc.numPages };
}

/**
 * The box around part of a text item.
 *
 * pdf.js gives one box per run of text, so a match inside a longer run is
 * located by assuming the glyphs are evenly spaced. That is not exact for
 * proportional fonts, so the box is padded rather than trimmed: covering a
 * little extra is harmless, covering too little is a leak.
 */
function sliceBox(item, start, length) {
  const box = boxFor(item);
  if (item.str.length === 0) return box;

  const perChar = box.width / item.str.length;
  const pad = perChar * 0.6;

  return {
    x: Math.max(box.x, box.x + start * perChar - pad),
    y: box.y,
    width: Math.min(box.width, length * perChar + pad * 2),
    height: box.height,
  };
}

function buildRegexes(spec) {
  const flags = spec.caseSensitive ? 'g' : 'gi';
  const regexes = [];

  if (spec.text) {
    const escaped = spec.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    regexes.push({ regex: new RegExp(escaped, flags) });
  }

  if (spec.pattern) {
    try {
      regexes.push({ regex: new RegExp(spec.pattern, flags) });
    } catch (error) {
      throw new Error(`That pattern is not valid: ${error.message}`);
    }
  }

  for (const category of spec.categories ?? []) {
    const entry = PII_PATTERNS[category];
    if (!entry) {
      throw new Error(
        `Unknown category "${category}". Available: ${Object.keys(PII_PATTERNS).join(', ')}.`,
      );
    }
    regexes.push({ regex: new RegExp(entry.regex.source, 'g') });
  }

  return regexes;
}

/** Count matches per category, for reporting without revealing the text. */
export async function countByCategory(bytes, categories) {
  const counts = {};
  for (const category of categories) {
    const { total } = await findMatches(bytes, { categories: [category] });
    counts[category] = total;
  }
  return counts;
}

/**
 * Render pages to images with the redactions burned in.
 *
 * Drawing a black rectangle over text does not remove it: the glyphs stay in
 * the file and any PDF reader will copy them straight back out. Verified with
 * pdftotext on a boxed file, which returned the "hidden" address in full.
 *
 * The dependable fix in the browser is to rasterise: the page becomes an image,
 * so the covered text is not merely hidden but gone. It costs selectable text on
 * the redacted pages, which is the right trade when the whole point is that
 * something must not be recoverable. Pages with no matches are left untouched,
 * so a document keeps its text everywhere it can.
 *
 * @param {ArrayBuffer} bytes
 * @param {Array<{page: number, boxes: Array}>} redactions
 * @param {number} scale  Render resolution. 2 keeps small print readable.
 */
export async function rasterisePages(bytes, redactions, scale = 2) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const rendered = [];

  for (const entry of redactions) {
    const page = await doc.getPage(entry.page);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d');

    // A white ground, because a PDF page is white and a canvas starts clear.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;

    // PDF user space has its origin at the bottom left, canvas at the top left.
    context.fillStyle = '#000000';
    for (const box of entry.boxes) {
      context.fillRect(
        box.x * scale,
        canvas.height - (box.y + box.height) * scale,
        box.width * scale,
        box.height * scale,
      );
    }

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.92),
    );
    rendered.push({
      page: entry.page,
      bytes: await blob.arrayBuffer(),
      width: viewport.width / scale,
      height: viewport.height / scale,
    });
  }

  return rendered;
}

/**
 * Which pages have nothing on them.
 *
 * Scanned documents and exported reports are full of these, and finding them by
 * eye in a long file is exactly the tedium worth handing to a tool. A page
 * counts as blank when it carries no text and almost no ink: rendering it small
 * and checking how many pixels are not white catches both empty pages and pages
 * holding only a faint header.
 */
export async function findBlankPages(bytes, { inkThreshold = 0.002 } = {}) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(0) }).promise;
  const blank = [];

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    const page = await doc.getPage(pageNumber);

    const content = await page.getTextContent();
    const hasText = content.items.some((item) => item.str && item.str.trim().length > 0);
    if (hasText) continue;

    // No text is not enough: the page could be an image or a chart.
    const viewport = page.getViewport({ scale: 0.2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0;
    for (let i = 0; i < data.length; i += 4) {
      // Anything clearly darker than paper counts as ink.
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) inked++;
    }
    const ratio = inked / (canvas.width * canvas.height);
    if (ratio <= inkThreshold) blank.push(pageNumber);
  }

  return { blank, pageCount: doc.numPages };
}
