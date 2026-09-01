// The second half of the report, kept as its own file the way a real one is:
// the summary goes round for review, the signed schedule arrives later from
// somebody else, and the two have to be joined before anything is filed.
//
// It carries its own mess on purpose: blank separator pages the scanner added,
// a schedule printed sideways, and a signature block full of personal data. So
// merging is not the whole job, it is the last step after cleaning both halves.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const A4 = [595, 842];
const INK = rgb(0.1, 0.1, 0.12);
const GREY = rgb(0.55, 0.55, 0.6);

function textPage(title, lines, { pageLabel } = {}) {
  const page = doc.addPage(A4);
  let y = 770;
  page.drawText(title, { x: 60, y, size: 20, font: bold, color: INK });
  y -= 34;
  page.drawLine({ start: { x: 60, y }, end: { x: 535, y }, thickness: 1, color: GREY });
  y -= 26;
  for (const line of lines) {
    if (line === '') { y -= 10; continue; }
    page.drawText(line, { x: 60, y, size: 11, font, color: INK });
    y -= 18;
  }
  if (pageLabel) page.drawText(pageLabel, { x: 60, y: 40, size: 9, font, color: GREY });
  return page;
}

// 1. Cover
textPage('SUPPLIER ADDENDUM', [
  'Attachment to the quarterly supplier report',
  'Reporting period: April to June 2026',
  '',
  'This attachment is sample data. Every name, address and account',
  'number in it is invented.',
  '',
  'It arrived separately from the report it belongs to, which is',
  'why it has its own cover, its own blank separator pages, and a',
  'signature block that should not be filed as it stands.',
], { pageLabel: 'Addendum, page 1 of 6' });

// 2. BLANK: the separator sheet the scanner picked up
doc.addPage(A4);

// 3. Terms
textPage('REVISED TERMS', [
  'Two suppliers renegotiated during the quarter. The revised',
  'terms below replace those in section 4 of the main report and',
  'take effect from the first of July.',
  '',
  'Northern route      45 days      was 30 days',
  'Coastal route       30 days      unchanged',
  'Inland route        30 days      was 45 days',
  '',
  'All other terms are rolled over without change.',
], { pageLabel: 'Addendum, page 3 of 6' });

// 4. A sideways schedule, printed landscape like the chart in the report
const schedule = doc.addPage([842, 595]);
{
  schedule.drawText('DELIVERY SCHEDULE (landscape)', {
    x: 50, y: 545, size: 14, font: bold, color: INK });
  const rows = [
    ['Week', 'Northern', 'Coastal', 'Inland'],
    ['1', '38', '22', '19'],
    ['2', '41', '24', '17'],
    ['3', '44', '21', '23'],
    ['4', '39', '26', '20'],
  ];
  rows.forEach((row, r) => {
    row.forEach((cell, c) => {
      schedule.drawText(cell, {
        x: 90 + c * 180, y: 470 - r * 34, size: 12,
        font: r === 0 ? bold : font, color: INK,
      });
    });
  });
  schedule.drawText('Addendum, page 4 of 6', { x: 50, y: 40, size: 9, font, color: GREY });
}

// 5. BLANK: a second separator
doc.addPage(A4);

// 6. The signature block: the reason this file cannot be filed as it stands
textPage('AUTHORISATION', [
  'Approved on behalf of the operations team.',
  '',
  'Name        Marta Iglesias Ruiz',
  'Role        Operations lead',
  'Email       marta.iglesias@example-supplier.es',
  'Phone       +34 611 234 987',
  'ID number   51234567X',
  'IBAN        ES91 2100 0418 4502 0005 1332',
  '',
  'Countersigned by the supplier on 30 June 2026.',
  '',
  'End of addendum.',
], { pageLabel: 'Addendum, page 6 of 6' });

writeFileSync(process.argv[2], await doc.save());
console.log('wrote', process.argv[2], '-', doc.getPageCount(), 'pages');
