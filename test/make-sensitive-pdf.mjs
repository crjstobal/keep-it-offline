// A document with the kinds of data people actually need to black out.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

const page = doc.addPage([595, 842]);
let y = 780;
const line = (text, f = font, size = 12) => {
  page.drawText(text, { x: 60, y, size, font: f, color: rgb(0, 0, 0) });
  y -= size + 8;
};

line('EMPLOYMENT CONTRACT', bold, 16);
y -= 10;
line('Employee: Alex Fernandez');
line('Email: alex.fernandez@example.com');
line('Phone: +34 612 345 678');
line('ID number: 12345678Z');
line('IBAN: ES91 2100 0418 4502 0005 1332');
line('Card on file: 4111 1111 1111 1111');
line('Start date: 01/09/2026');
y -= 10;
line('This paragraph is ordinary contract text that should survive');
line('redaction untouched, so that removing personal data does not');
line('destroy the rest of the document.');

const second = doc.addPage([595, 842]);
second.drawText('Page two: no personal data here at all.', {
  x: 60, y: 780, size: 12, font,
});
second.drawText('This page must keep its selectable text.', {
  x: 60, y: 760, size: 12, font,
});

writeFileSync(process.argv[2] ?? 'sensitive.pdf', await doc.save());
console.log('wrote', process.argv[2]);
