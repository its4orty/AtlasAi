import { PDFDocument, StandardFonts } from "pdf-lib";

/**
 * Synthetic EPC-style test document for the ATLAS AI document-intelligence
 * step (244 London Road, Croydon — the target demo address). Clearly marked
 * synthetic; used only to exercise the pipeline locally.
 */
const doc = await PDFDocument.create();
const page = doc.addPage([595, 842]); // A4 portrait
const font = await doc.embedFont(StandardFonts.Helvetica);

const lines = [
  "Energy Performance Certificate",
  "Ground floor office, 244 London Road, Croydon CR0 2TE",
  "Synthetic test document - ATLAS AI pipeline",
  "Total floor area: 64 m2",
  "Gross internal area: 62.5 sq m",
  "Use class: E",
  "Current energy rating: D",
  "Ceiling height: 2.8 m",
  "RRN: 1234-5678-9012-3456-7890",
  "Inspection date: 15/06/2025",
  "Current use: accountants office",
  "Reception 4.5m x 3.2m",
  "Open plan office 8.0m x 4.5m",
  "Kitchenette 2.5m x 2.0m",
  "WC 1.8m x 1.5m",
];

let y = 800;
for (const line of lines) {
  page.drawText(line, { x: 60, y, size: 11, font });
  y -= 26;
}

const bytes = await doc.save();
const out = "/home/team/shared/data/test-epc-244-london-road.pdf";
await Bun.write(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes)`);
