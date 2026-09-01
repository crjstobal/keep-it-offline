// A sample document built to exercise every PDF action the app offers:
// blank pages to remove, a sideways table to rotate, personal data to redact,
// and ordinary prose that should survive all of it untouched.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const mono = await doc.embedFont(StandardFonts.Courier);

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
  if (pageLabel) {
    page.drawText(pageLabel, { x: 60, y: 40, size: 9, font, color: GREY });
  }
  return page;
}

// 1. Cover
textPage('QUARTERLY SUPPLIER REPORT', [
  'Prepared for the operations team',
  'Reporting period: April to June 2026',
  '',
  'This document is sample data. Every name, address and account',
  'number in it is invented, and it exists only so that a file',
  'workbench has something realistic to work on.',
  '',
  'It deliberately contains blank pages, a table printed sideways,',
  'and a block of personal data, so that removing, rotating and',
  'redacting can each be tried on something that looks real.',
], { pageLabel: 'Page 1 of 12' });

// 2. Prose that must survive everything
textPage('SUMMARY', [
  'Deliveries arrived on time in 94 per cent of cases this quarter,',
  'up from 89 per cent in the previous one. The improvement came',
  'almost entirely from the northern route, where the change of',
  'carrier in May removed a recurring two-day delay.',
  '',
  'Costs rose by 3 per cent, which is below the increase in fuel',
  'prices over the same period. Two suppliers renegotiated their',
  'terms; the rest were rolled over unchanged.',
  '',
  'No incidents were recorded. One near miss at the loading bay',
  'was reported and has since been addressed with new signage.',
  '',
  'This page contains nothing personal and nothing sideways. It is',
  'here so that you can check an edit did not damage the rest of',
  'the document.',
], { pageLabel: 'Page 2 of 12' });

// 3. BLANK
const blank1 = doc.addPage(A4);
blank1.drawText('', { x: 60, y: 700, size: 11, font });

// 4. Personal data, for redaction
const contact = doc.addPage(A4);
{
  let y = 770;
  contact.drawText('SUPPLIER CONTACT SHEET', { x: 60, y, size: 20, font: bold, color: INK });
  y -= 34;
  contact.drawLine({ start: { x: 60, y }, end: { x: 535, y }, thickness: 1, color: GREY });
  y -= 30;
  const rows = [
    ['Account manager', 'Alex Fernandez'],
    ['Email', 'alex.fernandez@northgate-supplies.example.com'],
    ['Direct line', '+34 612 345 678'],
    ['Mobile', '+44 7700 900123'],
    ['Tax ID', '12345678Z'],
    ['Bank account (IBAN)', 'ES91 2100 0418 4502 0005 1332'],
    ['Corporate card', '4111 1111 1111 1111'],
    ['Contract signed', '01/04/2026'],
    ['Renewal date', '31/03/2027'],
    ['Address', '14 Harbour Road, Bristol BS1 4TY'],
  ];
  for (const [label, value] of rows) {
    contact.drawText(label, { x: 60, y, size: 11, font, color: GREY });
    contact.drawText(value, { x: 230, y, size: 11, font, color: INK });
    y -= 24;
  }
  y -= 14;
  contact.drawText('Every value above is invented. Try redacting by category:', {
    x: 60, y, size: 10, font, color: GREY });
  y -= 16;
  contact.drawText('email, phone, iban, card, id_number, date.', {
    x: 60, y, size: 10, font, color: GREY });
  contact.drawText('Page 4 of 12', { x: 60, y: 40, size: 9, font, color: GREY });
}

// 5. A table printed sideways, for rotation
const table = doc.addPage([842, 595]); // landscape
{
  table.drawText('DELIVERY TIMES BY ROUTE (this page is landscape: try rotating it)', {
    x: 50, y: 545, size: 14, font: bold, color: INK });
  const headers = ['Route', 'Deliveries', 'On time', 'Late', 'Average delay'];
  const rows = [
    ['Northern', '412', '398', '14', '0.4 days'],
    ['Southern', '388', '351', '37', '1.1 days'],
    ['Coastal', '204', '199', '5', '0.2 days'],
    ['Inland', '156', '141', '15', '0.9 days'],
    ['Overnight', '97', '95', '2', '0.1 days'],
    ['Total', '1257', '1184', '73', '0.6 days'],
  ];
  let y = 500;
  const xs = [50, 220, 360, 480, 590];
  headers.forEach((h, i) => table.drawText(h, { x: xs[i], y, size: 11, font: bold, color: INK }));
  y -= 8;
  table.drawLine({ start: { x: 50, y }, end: { x: 790, y }, thickness: 1, color: GREY });
  y -= 22;
  for (const row of rows) {
    row.forEach((cell, i) =>
      table.drawText(cell, { x: xs[i], y, size: 11, font: i === 0 ? font : mono, color: INK }));
    y -= 22;
  }
  table.drawText('Page 5 of 12', { x: 50, y: 40, size: 9, font, color: GREY });
}

// 6. BLANK
doc.addPage(A4);

// 7-8. More prose
textPage('SUPPLIER NOTES', [
  'Northgate Supplies moved to a new depot in May. Their lead time',
  'dropped by a day as a result, and their invoices now arrive',
  'weekly rather than monthly.',
  '',
  'Harbour Freight remains the slowest of the five, though not by',
  'enough to justify the cost of switching. Their contract is up',
  'for renewal in March and should be revisited then.',
  '',
  'Two smaller suppliers were added this quarter and are still',
  'inside their trial period. Neither has missed a delivery.',
], { pageLabel: 'Page 7 of 12' });

textPage('RISKS AND ACTIONS', [
  'Fuel prices are the main exposure. A ten per cent rise would',
  'add roughly four per cent to the quarterly total, which is',
  'within tolerance but worth watching.',
  '',
  'The single-carrier dependency on the coastal route has been',
  'flagged twice now. A second carrier has been approached and',
  'a decision is expected before the next report.',
  '',
  'Actions carried forward: renegotiate Harbour Freight terms,',
  'complete the coastal route second-carrier assessment, and',
  'review the loading bay signage change after three months.',
], { pageLabel: 'Page 8 of 12' });

// 9. BLANK
doc.addPage(A4);

// 10. A second sideways page
const chart = doc.addPage([842, 595]);
{
  chart.drawText('MONTHLY VOLUME (also landscape)', {
    x: 50, y: 545, size: 14, font: bold, color: INK });
  const months = ['Apr', 'May', 'Jun'];
  const values = [389, 421, 447];
  const max = 500;
  values.forEach((value, i) => {
    const h = (value / max) * 380;
    chart.drawRectangle({
      x: 120 + i * 200, y: 90, width: 120, height: h,
      color: rgb(0.29, 0.87, 0.5),
    });
    chart.drawText(months[i], { x: 165 + i * 200, y: 66, size: 12, font, color: INK });
    chart.drawText(String(value), { x: 160 + i * 200, y: 100 + h, size: 12, font: bold, color: INK });
  });
  chart.drawText('Page 10 of 12', { x: 50, y: 40, size: 9, font, color: GREY });
}

// 11. BLANK
doc.addPage(A4);

// 12. Closing
textPage('APPENDIX', [
  'Figures are drawn from the delivery log and rounded to the',
  'nearest whole delivery. Percentages are calculated before',
  'rounding, so columns may not sum exactly.',
  '',
  'Questions about this report should go to the operations desk.',
  '',
  'End of document.',
], { pageLabel: 'Page 12 of 12' });

writeFileSync(process.argv[2], await doc.save());
console.log('wrote', process.argv[2], '-', doc.getPageCount(), 'pages');
