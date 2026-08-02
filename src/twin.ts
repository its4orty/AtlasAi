import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { parseDim } from "~/design";

/**
 * ATLAS AI — Phase 1 "digital twin": an as-built spatial model of the EXISTING
 * property, rendered from confidence-scored space facts already in project
 * memory (document-intelligence room facts, or EPC total floor area).
 *
 * This is deliberately NOT a 3D / photorealistic / interactive twin (that is a
 * later phase): it is a structured, honest representation of the CURRENT
 * layout — an as-built floor-plan SVG in the same CAD-style visual language as
 * the concept design (src/design.ts), a plain-English layout description, and
 * a data-coverage note listing exactly which facts the drawing is based on.
 * It is the "before" to the concept design's "after".
 *
 * Honesty rules (same as the rest of the platform):
 *  - Never invents rooms or dimensions that are not in the facts.
 *  - When only a total floor area exists (no room-level facts), draws a simple
 *    footprint rectangle with the total area and says so explicitly.
 *  - Room-to-room adjacency, wall positions and door/window locations are NOT
 *    measured — the layout is indicative, not a surveyed plan.
 *  - Confidence and sources of every contributing fact are surfaced in the
 *    data-coverage note and the report.
 *
 * Public entry point: runTwinStep(db, projectId) — called by the pipeline's
 * 'twin' step (after 'compliance', before 'report'); writes category "twin"
 * facts plus an 'ATLAS AI as-built model' source row into project memory.
 */

type Db = ReturnType<typeof sql>;

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const round1 = (n: number): number => Math.round(n * 10) / 10;

/* ------------------------------------------------------------------ */
/* Space model from project memory                                     */
/* ------------------------------------------------------------------ */

export interface TwinFactLike {
  category: string;
  key: string;
  value: string;
  confidence: number;
  source_name?: string | null;
}

export interface TwinRoom {
  label: string;
  width: number; // m
  height: number; // m
  area: number; // m²
}

export interface DigitalTwin {
  rooms: TwinRoom[];
  footprintOnly: boolean;
  totalAreaM2: number | null;
  /** Min confidence of the room-dimension facts used (or null when none). */
  roomsConfidence: number | null;
  /** Confidence of the total-floor-area fact used (or null when none). */
  areaConfidence: number | null;
  /** Contributing facts, for the coverage note (key = value, conf, source). */
  coverageFacts: TwinFactLike[];
  layoutDescription: string;
  dataCoverage: string;
  svg: string;
  generatedAt: string;
}

/** Area fact: uploaded-document intelligence wins; the EPC register is the fallback. */
function pickAreaFact(facts: TwinFactLike[]): TwinFactLike | null {
  return (
    facts.find((f) => f.category === "intelligence" && f.key === "total_floor_area_m2") ??
    facts.find((f) => f.category === "epc" && f.key === "total_floor_area_m2") ??
    null
  );
}

/**
 * Build the room model from intelligence facts. Room labels are paired with
 * room dimensions in document order — the same explicit assumption as the
 * concept design, flagged in the coverage note.
 *
 * Facts accumulate across pipeline re-runs (a re-run appends a fresh set of
 * room facts), so dimension and label facts are deduplicated by value before
 * pairing — otherwise re-runs would multiply the room count. Identical rooms
 * from genuinely different documents are still merged; Phase 1 accepts this
 * (per-fact provenance is shown in the coverage note).
 */
function buildTwinRooms(facts: TwinFactLike[]): { rooms: TwinRoom[]; confidence: number | null } {
  const dimFacts: TwinFactLike[] = [];
  const seenDims = new Set<string>();
  for (const f of facts) {
    if (f.category !== "intelligence" || f.key !== "room_dimension_m") continue;
    if (seenDims.has(f.value)) continue;
    seenDims.add(f.value);
    dimFacts.push(f);
  }
  const labelFacts: TwinFactLike[] = [];
  const seenLabels = new Set<string>();
  for (const f of facts) {
    if (f.category !== "intelligence" || f.key !== "room_label") continue;
    if (seenLabels.has(f.value)) continue;
    seenLabels.add(f.value);
    labelFacts.push(f);
  }
  const dims = dimFacts.map((f) => ({ dim: parseDim(f.value), confidence: f.confidence }));
  const labels = labelFacts.map((f) => f.value);
  const rooms: TwinRoom[] = [];
  let confidence = 1;
  dims.forEach((d, i) => {
    if (!d.dim) return;
    confidence = Math.min(confidence, d.confidence);
    rooms.push({
      label: labels[i] ? labels[i].toUpperCase() : `ROOM ${i + 1}`,
      width: d.dim.width,
      height: d.dim.height,
      area: round1(d.dim.width * d.dim.height),
    });
  });
  return { rooms, confidence: rooms.length > 0 ? confidence : null };
}

/* ------------------------------------------------------------------ */
/* Plain-English layout description + honest data-coverage note        */
/* ------------------------------------------------------------------ */

function layoutDescription(rooms: TwinRoom[], totalAreaM2: number | null, footprintOnly: boolean): string {
  if (footprintOnly) {
    return `As-built model (footprint only): the total floor area is recorded as ${totalAreaM2} m², but no room-level dimensions or labels are available from the evidence. The drawing shows a single footprint rectangle at an indicative shape — the true footprint shape and internal layout are not known from the facts.`;
  }
  const roomList = rooms.map((r) => `${r.label} (${r.area} m²)`).join(", ");
  const roomsSum = round1(rooms.reduce((acc, r) => acc + r.area, 0));
  const unaccounted = totalAreaM2 !== null ? round1(totalAreaM2 - roomsSum) : null;
  return `As-built model (indicative): ${rooms.length} room(s) recorded — ${roomList}. Measured rooms total ${roomsSum} m²${
    totalAreaM2 !== null
      ? ` of the ${totalAreaM2} m² recorded floor area${unaccounted !== null && unaccounted > 0.05 ? ` (${unaccounted} m² not accounted for by room facts — circulation, corridors or unmeasured space)` : ""}`
      : " (total floor area not recorded)"
  }. Room-to-room adjacency and wall positions were not measured — this is an indicative arrangement, not a surveyed plan.`;
}

function dataCoverageNote(rooms: TwinRoom[], totalAreaM2: number | null, footprintOnly: boolean, coverageFacts: TwinFactLike[]): string {
  const basis = coverageFacts.map((f) => `${f.key} = "${f.value}" (${Math.round(f.confidence * 100)}% confidence, source: ${f.source_name ?? "inferred"})`);
  const known = [
    `Drawing based on ${coverageFacts.length} fact(s) from project memory: ${basis.join("; ")}.`,
    rooms.length > 0
      ? "Room labels are paired with room dimensions in document order — a pairing assumption that may mislabel rooms."
      : "No room-level dimensions were extracted — the drawing is a footprint only.",
    totalAreaM2 !== null ? `Total floor area ${totalAreaM2} m² shown${footprintOnly ? " (shape illustrative — only the area is known from the evidence)" : ""}.` : "Total floor area not recorded in the evidence.",
  ];
  const notKnown = [
    "room-to-room adjacency not measured",
    "wall positions and door/window locations not recorded",
    "floor level(s) not established",
    "layout is indicative, not surveyed",
  ];
  return `${known.join(" ")} Not known: ${notKnown.join("; ")}. Verify with a measured survey before any design or construction work.`;
}

/* ------------------------------------------------------------------ */
/* CAD-style as-built SVG renderer (same visual language as design.ts) */
/* ------------------------------------------------------------------ */

const SCALE = 50; // px per metre (~1:50 on A4)

function renderTwinSvg(c: {
  address: string;
  rooms: TwinRoom[];
  footprintOnly: boolean;
  totalAreaM2: number | null;
  generatedAt: string;
}): string {
  const { rooms } = c;
  const gap = 26;
  const margin = 44;
  const dimGap = 34; // space below each room for the width dimension line
  const scaleBarH = 46;
  const titleH = 92;
  const topNoteH = 20;

  const roomW = (r: TwinRoom) => Math.max(40, Math.round(r.width * SCALE));
  const roomH = (r: TwinRoom) => Math.max(40, Math.round(r.height * SCALE));
  const maxH = rooms.reduce((m, r) => Math.max(m, roomH(r)), 0);

  const planW = rooms.reduce((acc, r, i) => acc + roomW(r) + (i > 0 ? gap : 0), 0);
  const width = margin * 2 + planW;
  const height = margin + topNoteH + maxH + dimGap + scaleBarH + titleH + margin;

  const roomX = (i: number) => margin + rooms.slice(0, i).reduce((acc, r) => acc + roomW(r) + gap, 0);
  const roomTop = margin + topNoteH;

  // ---- grid ----
  let grid = "";
  for (let gx = margin; gx <= margin + planW; gx += SCALE) {
    grid += `<line x1="${gx}" y1="${roomTop}" x2="${gx}" y2="${roomTop + maxH}" stroke="#ece7dc" stroke-width="0.6"/>`;
  }
  for (let gy = roomTop; gy <= roomTop + maxH; gy += SCALE) {
    grid += `<line x1="${margin}" y1="${gy}" x2="${margin + planW}" y2="${gy}" stroke="#ece7dc" stroke-width="0.6"/>`;
  }

  // ---- rooms (as-built: no zones, no new partitions) ----
  let roomsSvg = "";
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    const x = roomX(i);
    const y = roomTop;
    const w = roomW(r);
    const h = roomH(r);
    const cx = x + w / 2;

    roomsSvg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="#101820" stroke-width="3"/>`;
    roomsSvg += `<rect x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" fill="none" stroke="#101820" stroke-width="0.8"/>`;

    roomsSvg += `<text x="${cx}" y="${y + 17}" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="700" fill="#101820">${esc(r.label)}</text>`;
    roomsSvg += `<text x="${cx}" y="${y + 30}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" fill="#27323a">${r.width} × ${r.height} m · ${r.area} m²</text>`;

    // dimension lines — width below, height right
    const dimY = y + h + 12;
    roomsSvg += `<line x1="${x - 8}" y1="${dimY}" x2="${x + w + 8}" y2="${dimY}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<line x1="${x}" y1="${dimY - 5}" x2="${x}" y2="${dimY + 5}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<line x1="${x + w}" y1="${dimY - 5}" x2="${x + w}" y2="${dimY + 5}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<text x="${cx}" y="${dimY + 16}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="9" fill="#101820">${r.width} m</text>`;

    const dimX = x + w + 12;
    roomsSvg += `<line x1="${dimX}" y1="${y - 8}" x2="${dimX}" y2="${y + h + 8}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<line x1="${dimX - 5}" y1="${y}" x2="${dimX + 5}" y2="${y}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<line x1="${dimX - 5}" y1="${y + h}" x2="${dimX + 5}" y2="${y + h}" stroke="#101820" stroke-width="0.8"/>`;
    roomsSvg += `<text x="${dimX + 10}" y="${y + h / 2 + 3}" font-family="ui-monospace,Menlo,monospace" font-size="9" fill="#101820">${r.height} m</text>`;
  }

  // ---- scale bar (0–5 m) ----
  let scaleBar = "";
  const sbX = margin;
  const sbY = roomTop + maxH + dimGap + 6;
  for (let s = 0; s <= 5; s++) {
    const sx = sbX + s * SCALE;
    const hh = s % 5 === 0 ? 10 : s % 1 === 0 ? 7 : 4;
    scaleBar += `<line x1="${sx}" y1="${sbY}" x2="${sx}" y2="${sbY + hh}" stroke="#101820" stroke-width="1"/>`;
    scaleBar += `<text x="${sx}" y="${sbY + hh + 11}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="7.5" fill="#27323a">${s}</text>`;
  }
  scaleBar += `<line x1="${sbX}" y1="${sbY}" x2="${sbX + 5 * SCALE}" y2="${sbY}" stroke="#101820" stroke-width="1"/>`;
  scaleBar += `<text x="${sbX}" y="${sbY - 6}" font-family="ui-monospace,Menlo,monospace" font-size="7.5" fill="#27323a">SCALE 1:50 · 0–5 m</text>`;

  // ---- north arrow ----
  const nx = margin + planW;
  const ny = roomTop - 10;
  const north = `<g transform="translate(${nx},${ny})">
    <circle r="11" fill="none" stroke="#27323a" stroke-width="0.8"/>
    <path d="M0,-8 L3,6 L0,3 L-3,6 Z" fill="#101820"/>
    <text x="0" y="-14" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">N</text>
  </g>`;

  // ---- title block ----
  const tbY = sbY + 26;
  const evidenceLine = c.footprintOnly
    ? `Footprint only — total area ${c.totalAreaM2} m² (no room-level detail)`
    : `${rooms.length} room(s) from project-memory evidence${c.totalAreaM2 !== null ? ` · total ${c.totalAreaM2} m²` : ""}`;
  const tb = `<g>
    <rect x="${margin}" y="${tbY}" width="${Math.min(planW + margin, 460)}" height="${titleH - 8}" fill="#ffffff" stroke="#101820" stroke-width="1.2"/>
    <text x="${margin + 12}" y="${tbY + 18}" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="700" fill="#101820">ATLAS AI — EXISTING LAYOUT (AS-BUILT)</text>
    <text x="${margin + 12}" y="${tbY + 34}" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">${esc(c.address)}</text>
    <text x="${margin + 12}" y="${tbY + 48}" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">${esc(evidenceLine)}</text>
    <text x="${margin + 12}" y="${tbY + 62}" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">Generated ${esc(c.generatedAt)} · scale 1:50</text>
    <text x="${margin + 12}" y="${tbY + 76}" font-family="ui-monospace,Menlo,monospace" font-size="7.5" fill="#8a5a1e">INDICATIVE LAYOUT — NOT SURVEYED. Room-to-room adjacency not measured; verify with a survey.</text>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="'DM Sans',ui-sans-serif,sans-serif" role="img" aria-label="As-built floor plan (indicative) for ${esc(c.address)}">
  ${grid}
  ${roomsSvg}
  ${scaleBar}
  ${north}
  ${tb}
  </svg>`;
}

/* ------------------------------------------------------------------ */
/* Public: build the twin from memory facts (pure)                     */
/* ------------------------------------------------------------------ */

/**
 * Build the as-built digital twin from the project's space facts. Returns null
 * only when there are NO space facts at all (no room facts, no floor area) —
 * the report handles that case gracefully. Footprint-only twins are generated
 * (not null) and labelled honestly.
 */
export function buildTwin(factRows: TwinFactLike[], address: string): DigitalTwin | null {
  const facts = factRows.filter((f) => f.key !== "documents_processed");
  const { rooms, confidence: roomsConfidence } = buildTwinRooms(facts);
  const areaFact = pickAreaFact(facts);
  const totalAreaM2 = areaFact && Number.parseFloat(areaFact.value) > 0 ? round1(Number.parseFloat(areaFact.value)) : null;

  if (rooms.length === 0 && totalAreaM2 === null) return null;

  const generatedAt = new Date().toISOString().slice(0, 10);

  if (rooms.length === 0 && totalAreaM2 !== null) {
    // Footprint-only: honest rectangle from the total area, shape illustrative.
    const a = totalAreaM2;
    const w = round1(Math.sqrt(a));
    const h = round1(a / w);
    const fpRooms: TwinRoom[] = [{ label: "FULL FLOOR (AREA ONLY)", width: w, height: h, area: a }];
    const coverageFacts = areaFact ? [areaFact] : [];
    return {
      rooms: fpRooms,
      footprintOnly: true,
      totalAreaM2,
      roomsConfidence: null,
      areaConfidence: areaFact ? areaFact.confidence : null,
      coverageFacts,
      layoutDescription: layoutDescription(fpRooms, totalAreaM2, true),
      dataCoverage: dataCoverageNote(fpRooms, totalAreaM2, true, coverageFacts),
      svg: renderTwinSvg({ address, rooms: fpRooms, footprintOnly: true, totalAreaM2, generatedAt }),
      generatedAt,
    };
  }

  const dedupeByValue = (key: string): TwinFactLike[] => {
    const seen = new Set<string>();
    const out: TwinFactLike[] = [];
    for (const f of facts) {
      if (f.category !== "intelligence" || f.key !== key) continue;
      if (seen.has(f.value)) continue;
      seen.add(f.value);
      out.push(f);
    }
    return out;
  };
  const coverageFacts = [
    ...dedupeByValue("room_dimension_m"),
    ...dedupeByValue("room_label"),
    ...(areaFact ? [areaFact] : []),
  ];
  return {
    rooms,
    footprintOnly: false,
    totalAreaM2,
    roomsConfidence,
    areaConfidence: areaFact ? areaFact.confidence : null,
    coverageFacts,
    layoutDescription: layoutDescription(rooms, totalAreaM2, false),
    dataCoverage: dataCoverageNote(rooms, totalAreaM2, false, coverageFacts),
    svg: renderTwinSvg({ address, rooms, footprintOnly: false, totalAreaM2, generatedAt }),
    generatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* Pipeline step: write the twin into project memory                   */
/* ------------------------------------------------------------------ */

export interface TwinStepOutput {
  status: "done";
  output: {
    note: string;
    facts: Array<{ category: string; key: string; value: string; confidence: number; sourceId: string | null }>;
    sources: Array<{ name: string; url: string | null; notes: string | null }>;
  };
}

/**
 * Run the as-built twin step: reads space facts from project memory, builds
 * the twin (or records an honest absence), and writes category "twin" facts
 * plus an 'ATLAS AI as-built model' source row. Called by the pipeline's
 * 'twin' step — the run row is managed by the pipeline runner, not here.
 */
export async function runTwinStep(db: Db, projectId: string): Promise<TwinStepOutput> {
  await ensureSchema();

  const [proj] = await db`SELECT address FROM projects WHERE id = ${projectId}`;
  if (!proj) throw new Error("project not found");

  const rows = await db`
    SELECT f.category, f.key, f.value, f.confidence, s.name AS source_name
    FROM facts f LEFT JOIN sources s ON s.id = f.source_id
    WHERE f.project_id = ${projectId}`;
  const factRows: TwinFactLike[] = rows.map((r) => ({
    category: String(r.category),
    key: String(r.key),
    value: String(r.value),
    confidence: Number(r.confidence),
    source_name: r.source_name === null || r.source_name === undefined ? null : String(r.source_name),
  }));

  const twin = buildTwin(factRows, String(proj.address));

  const [src] = await db`
    INSERT INTO sources (project_id, name, url, notes)
    VALUES (${projectId}, 'ATLAS AI as-built model', NULL,
      'Rule-based as-built model generated from confidence-scored space facts already in project memory (document intelligence / EPC register). Never invents rooms or dimensions; footprint-only when only a total area exists; room-to-room adjacency not measured — indicative, not a surveyed plan.')
    RETURNING id`;
  const sourceId = String(src.id);

  const factOuts: TwinStepOutput["output"]["facts"] = [];
  let note: string;

  if (!twin) {
    const gapNote =
      "No space facts in project memory: no room-level dimensions/labels from document intelligence and no EPC floor area. The as-built model cannot be generated. Upload a floor plan or EPC (or enable the EPC register lookup) and re-run the analysis.";
    factOuts.push(
      { category: "twin", key: "twin_status", value: "no-space-evidence", confidence: 1, sourceId },
      { category: "twin", key: "twin_data_coverage", value: gapNote, confidence: 0.95, sourceId },
    );
    note = "No space evidence in project memory — as-built model not generated (honest gap recorded).";
  } else {
    factOuts.push(
      { category: "twin", key: "twin_status", value: "generated", confidence: 1, sourceId },
      { category: "twin", key: "twin_floor_plan_svg", value: twin.svg, confidence: 0.5, sourceId },
      { category: "twin", key: "twin_layout_description", value: twin.layoutDescription, confidence: twin.footprintOnly ? 0.7 : 0.6, sourceId },
      { category: "twin", key: "twin_data_coverage", value: twin.dataCoverage, confidence: 0.95, sourceId },
      {
        category: "twin",
        key: "twin_rooms",
        value: JSON.stringify(twin.rooms.map((r) => ({ label: r.label, width_m: r.width, height_m: r.height, area_m2: r.area }))),
        confidence: twin.roomsConfidence ?? 0.5,
        sourceId,
      },
      { category: "twin", key: "twin_total_area_m2", value: String(twin.totalAreaM2), confidence: twin.areaConfidence ?? 0.5, sourceId },
    );
    note = twin.footprintOnly
      ? `As-built twin generated (footprint only, ${twin.totalAreaM2} m²; no room-level detail available in the evidence).`
      : `As-built twin generated from ${twin.rooms.length} room fact(s)${twin.totalAreaM2 !== null ? `, ${twin.totalAreaM2} m² total` : ""} (indicative — not surveyed).`;
  }

  for (const f of factOuts) {
    await db`
      INSERT INTO facts (project_id, category, key, value, confidence, source_id)
      VALUES (${projectId}, ${f.category}, ${f.key}, ${f.value}, ${f.confidence}, ${f.sourceId})`;
  }

  return {
    status: "done",
    output: {
      note,
      facts: factOuts,
      sources: [{ name: "ATLAS AI as-built model", url: null, notes: "Rule-based as-built model generated from project-memory space facts; indicative only, not a surveyed plan." }],
    },
  };
}
