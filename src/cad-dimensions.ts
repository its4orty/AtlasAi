import fs from "node:fs/promises";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import type { DimensionedCadModel, Dimension, Point } from "./cad";

export type ParsedDimension = { valueMm: number; raw: string; label?: string; page: number; confidence: number; sourceRef: string };
const NUM = "\\d+(?:[.,]\\d+)?";
/** Extract explicit metric/imperial dimensions from client document text. Never guesses units. */
export function parseDimensions(text: string, sourceRef = "client document", page = 1): ParsedDimension[] {
  const out: ParsedDimension[] = [];
  const add = (raw: string, n: number, confidence: number, label?: string) => { if (n > 0 && n < 100000) out.push({ valueMm: Math.round(n), raw, label, page, confidence, sourceRef }); };
  const context = text.replace(/\s+/g, " ");
  const metric = new RegExp(`(${NUM})\\s*(m(?:etre?s?)?|mm)\\b`, "gi");
  for (const m of context.matchAll(metric)) { const n = Number(m[1].replace(",", ".")); add(m[0], m[2].toLowerCase().startsWith("m") && !m[2].toLowerCase().startsWith("mm") ? n * 1000 : n, 0.9); }
  const imperial = new RegExp(`(\\d+)\\s*(?:'|ft)\\s*(?:(\\d+(?:[.,]\\d+)?)\\s*(?:[\"”]|in))?`, "gi");
  for (const m of context.matchAll(imperial)) add(m[0], (Number(m[1]) * 12 + Number((m[2] || "0").replace(",", "."))) * 25.4, 0.85);
  // A bare number is accepted only when the document explicitly declares its unit.
  const unitContext = context.match(/(?:dimensions?|units?)\\s*(?:are|shown|in)?\\s*[:=]?\\s*(mm|m)\\b/i)?.[1];
  if (unitContext) {
    const bare = new RegExp(`(?:width|length|depth|height|overall|opening)\\s*[:=]?\\s*(${NUM})(?!\\s*(?:mm|m)\\b)`, "gi");
    for (const m of context.matchAll(bare)) { const n=Number(m[1].replace(",", ".")); add(m[0], unitContext.toLowerCase()==="m"?n*1000:n, 0.7, m[0].split(/\\s/)[0]); }
  }
  return out;
}
export async function extractPdfDimensions(filePath: string, filename: string): Promise<ParsedDimension[]> {
  const data = await pdfParse(await fs.readFile(filePath));
  return parseDimensions(data.text, filename, 1);
}
/** Turn explicit document dimensions into conservative CAD geometry. Missing dimensions remain absent. */
export function modelFromDimensions(ds: ParsedDimension[]): DimensionedCadModel {
  const width = ds[0]?.valueMm ?? 0, depth = ds[1]?.valueMm ?? 0;
  const p: Point[] = width && depth ? [{x:0,y:0},{x:width,y:0},{x:width,y:depth},{x:0,y:depth},{x:0,y:0}] : [];
  const refs = ds.map(d => `${d.sourceRef} p${d.page} (${d.raw}; confidence ${d.confidence})`);
  const dimensions: Dimension[] = ds.slice(0, 2).map((d,i) => ({ id:`document-dimension-${i+1}`, valueMm:d.valueMm, a:i===0?{x:0,y:-300}:{x:width+300,y:0}, b:i===0?{x:width,y:-300}:{x:width+300,y:depth}, type:"overall", sourceRefs:[`${d.sourceRef} page ${d.page}; ${d.raw}; confidence ${d.confidence}`] }));
  return { units:"mm", walls:p.length ? [{id:"document-perimeter",geometry:"faces",points:p,sourceRefs:refs}] : [], openings:[], rooms:p.length ? [{id:"document-space",label:"Document-defined space",polygon:p,areaM2:width*depth/1e6,sourceRefs:refs}] : [], dimensions, levels:[], provenance:{sourceType:"client_document",sourceRefs:refs,declaredAccuracy:"client document dimensions; not a measured survey",confidence:ds.length ? Math.min(...ds.map(d=>d.confidence)) : 0,unresolvedDiscrepancies:ds.length>2?["Additional document dimensions were not mapped to geometry"]:[]}, titleBlock:{sourceType:"client_document",revision:"DOCUMENT-EXTRACTED",generatedAt:new Date().toISOString(),disclaimer:"Client document dimensions; verify against the source document and site. Not a measured survey."} };
}
