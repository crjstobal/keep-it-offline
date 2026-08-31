import { PDFDocument, rgb } from 'pdf-lib';
import { writeFileSync } from 'node:fs';
const doc = await PDFDocument.create();
for (let i = 0; i < 6; i++) {
  const p = doc.addPage([595, 842]);
  p.drawText(`Page ${i + 1}`, { x: 60, y: 700, size: 48, color: rgb(0.1, 0.1, 0.1) });
  p.drawRectangle({ x: 50, y: 50, width: 495, height: 742, borderColor: rgb(0,0,0), borderWidth: 2 });
}
writeFileSync(process.argv[2], await doc.save());
console.log('wrote', process.argv[2]);
