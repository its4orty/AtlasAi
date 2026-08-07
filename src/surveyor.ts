import type { DimensionedCadModel, Dimension } from "./cad";

export type SurveyRoom = { label?: string; widthMm: number; depthMm: number };
export type SurveyDimensions = { widthMm: number; depthMm: number; rooms?: SurveyRoom[]; notes?: string };
export const SURVEYOR_ACCURACY = "professional measured survey figures";
export function selectCadTier(hasSurveyor: boolean, hasClientDocument: boolean): "surveyor" | "client_document" | "demo" { return hasSurveyor ? "surveyor" : hasClientDocument ? "client_document" : "demo"; }
export function validateSurveyDimensions(input: Partial<SurveyDimensions>): string | null {
  for (const [key, value] of [["widthMm", input.widthMm], ["depthMm", input.depthMm]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100000) return `${key} must be a positive dimension in millimetres (maximum 100000)`;
  }
  if (input.rooms !== undefined) {
    if (!Array.isArray(input.rooms) || input.rooms.length > 100) return "rooms must be an array of at most 100 rooms";
    for (const room of input.rooms) if (!room || typeof room.widthMm !== "number" || !Number.isFinite(room.widthMm) || room.widthMm <= 0 || room.widthMm > 100000 || typeof room.depthMm !== "number" || !Number.isFinite(room.depthMm) || room.depthMm <= 0 || room.depthMm > 100000) return "room dimensions must be positive millimetres (maximum 100000)";
  }
  return null;
}
export function modelFromSurveyDimensions(input: SurveyDimensions, timestamp = new Date().toISOString()): DimensionedCadModel {
  const width = Math.round(input.widthMm), depth = Math.round(input.depthMm);
  const p = [{x:0,y:0},{x:width,y:0},{x:width,y:depth},{x:0,y:depth},{x:0,y:0}];
  const refs = [`surveyor-entry (${timestamp})`];
  const dimensions: Dimension[] = [
    {id:"surveyor-overall-width", valueMm:width, a:{x:0,y:-300}, b:{x:width,y:-300}, type:"overall", sourceRefs:refs},
    {id:"surveyor-overall-depth", valueMm:depth, a:{x:width+300,y:0}, b:{x:width+300,y:depth}, type:"overall", sourceRefs:refs},
  ];
  const rooms = (input.rooms ?? []).map((r, i) => { const w=Math.round(r.widthMm), d=Math.round(r.depthMm), x=0, y=i* (d+300); return {id:`surveyor-room-${i+1}`,label:r.label?.trim() || `Surveyed room ${i+1}`,polygon:[{x,y},{x:x+w,y},{x:x+w,y:y+d},{x,y:y+d},{x,y}],areaM2:w*d/1e6,sourceRefs:refs}; });
  return {units:"mm", walls:[{id:"surveyor-perimeter",geometry:"faces",points:p,sourceRefs:refs}], openings:[], rooms: rooms.length ? rooms : [{id:"surveyor-space",label:"Measured premises",polygon:p,areaM2:width*depth/1e6,sourceRefs:refs}], dimensions, levels:[], provenance:{sourceType:"surveyor",sourceRefs:refs,declaredAccuracy:SURVEYOR_ACCURACY,confidence:1,unresolvedDiscrepancies:[]}, titleBlock:{sourceType:"surveyor",revision:"SURVEYOR-ENTRY",generatedAt:timestamp,disclaimer:"Professional measured survey figures entered by the surveyor channel. ATLAS AI did not carry out the survey; verify source figures before construction use."}};
}
