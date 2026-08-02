import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { currentUseClass, targetUseClass, complianceVerdict } from "~/compliance";

/**
 * ATLAS AI — concept design generation (Phase 1).
 *
 * The "convert to X" step: given a target use (e.g. "barber shop"), it plans a
 * zoning concept from the space facts already in project memory (room
 * dimensions/labels, total floor area, ceiling height) and renders a CAD-style
 * SVG floor-plan concept — scaled rooms, dimension annotations, new partitions
 * drawn dashed, a title block, scale bar and north arrow.
 *
 * Honesty rules (same as the rest of the platform):
 *  - Everything is INDICATIVE. The concept is generated from confidence-scored
 *    evidence (EPC/floor-plan extracts) and stated programme assumptions; it is
 *    explicitly not for construction and not survey-accurate.
 *  - Zone areas are screening-level indicative sizes; circulation (20–30% of
 *    floor area) is left unallocated by design.
 *  - Room labels are paired with room dimensions by document order, which may
 *    mislabel rooms — the report flags this as needing a measured survey.
 *
 * Public entry point: runDesignStep(db, projectId, targetUse) — writes the
 * pipeline run row, source, facts and user decision into project memory.
 */

type Db = ReturnType<typeof sql>;

const esc = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/* ------------------------------------------------------------------ */
/* Target-use programmes (indicative screening sizes)                  */
/* ------------------------------------------------------------------ */

export type ZoneType = "front" | "work" | "wet" | "store";

export interface ZoneDef {
  id: string;
  name: string;
  minArea: number; // indicative total area for the zone, m²
  zoneType: ZoneType;
  affinity?: string[]; // room-label affinities ("wc", "kitchenette"…)
}

interface UseProgram {
  label: string;
  zones: ZoneDef[];
}

const z = (id: string, name: string, minArea: number, zoneType: ZoneType, affinity?: string[]): ZoneDef => ({
  id,
  name,
  minArea,
  zoneType,
  affinity,
});

/**
 * Indicative zone programmes per target use. Sizes are screening-level only —
 * they never imply a professional design; they drive an honest first sketch.
 */
const USE_PROGRAMS: Record<string, UseProgram> = {
  "barber shop": {
    label: "Barber shop",
    zones: [
      z("shopfront", "Shopfront / till", 3, "front", ["reception", "lobby"]),
      z("waiting", "Waiting area", 3, "front", ["reception"]),
      z("cutting", "Cutting stations ×2", 8, "work", ["office"]),
      z("backwash", "Backwash / styling", 3, "wet"),
      z("wc", "Customer WC", 2.7, "wet", ["wc", "toilet"]),
      z("store", "Staff store", 3, "store", ["kitchen", "kitchenette", "storage"]),
    ],
  },
  cafe: {
    label: "Café",
    zones: [
      z("counter", "Counter / service", 6, "front"),
      z("seating", "Seating", 14, "front"),
      z("kitchen", "Kitchen", 8, "work", ["kitchen", "kitchenette"]),
      z("wc", "Customer WC", 2.7, "wet", ["wc", "toilet"]),
      z("store", "Dry store", 3, "store"),
    ],
  },
  restaurant: {
    label: "Restaurant",
    zones: [
      z("dining", "Dining", 16, "front"),
      z("bar", "Bar / service", 4, "front"),
      z("kitchen", "Kitchen", 10, "work", ["kitchen", "kitchenette"]),
      z("wc", "WCs", 4, "wet", ["wc", "toilet"]),
      z("store", "Store", 4, "store"),
    ],
  },
  office: {
    label: "Office",
    zones: [
      z("reception", "Reception", 3, "front", ["reception", "lobby"]),
      z("desks", "Desk pool", 12, "work"),
      z("meeting", "Meeting room", 8, "work"),
      z("kitchenette", "Kitchenette", 4, "work", ["kitchen", "kitchenette"]),
      z("wc", "WC", 2.7, "wet", ["wc", "toilet"]),
      z("store", "Store", 2, "store"),
    ],
  },
  retail: {
    label: "Retail unit",
    zones: [
      z("sales", "Sales floor", 20, "front"),
      z("till", "Till / POS", 2, "front"),
      z("back", "Back-of-house", 6, "work"),
      z("wc", "Staff WC", 2.7, "wet", ["wc", "toilet"]),
      z("store", "Storage", 3, "store"),
    ],
  },
  gym: {
    label: "Gym / studio",
    zones: [
      z("studio", "Studio floor", 20, "work"),
      z("changing", "Changing", 6, "wet"),
      z("office", "Office", 3, "work"),
      z("store", "Store", 3, "store"),
    ],
  },
  "studio flat": {
    label: "Studio flat",
    zones: [
      z("living", "Living / sleeping", 14, "front"),
      z("kitchen", "Kitchen", 5, "work", ["kitchen", "kitchenette"]),
      z("bathroom", "Bathroom", 3.5, "wet", ["wc", "toilet", "bathroom"]),
      z("store", "Store", 2, "store"),
    ],
  },
  workshop: {
    label: "Workshop",
    zones: [
      z("bench", "Bench area", 12, "work"),
      z("machines", "Machine space", 10, "work"),
      z("store", "Materials store", 6, "store"),
      z("office", "Office", 3, "work"),
    ],
  },
};

const USE_ALIASES: Record<string, string> = {
  barbershop: "barber shop",
  barbers: "barber shop",
  barber: "barber shop",
  hairdresser: "barber shop",
  hairdressers: "barber shop",
  "hair salon": "barber shop",
  cafe: "cafe",
  café: "cafe",
  coffeeshop: "cafe",
  "coffee shop": "cafe",
  eatery: "restaurant",
  bistro: "restaurant",
  pub: "restaurant",
  office: "office",
  offices: "office",
  "office space": "office",
  retail: "retail",
  shop: "retail",
  store: "retail",
  gym: "gym",
  studio: "gym",
  "fitness studio": "gym",
  flat: "studio flat",
  apartment: "studio flat",
  residential: "studio flat",
  workshop: "workshop",
};

export function normaliseUse(input: string): string {
  const key = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) return "generic";
  const aliased = USE_ALIASES[key] ?? key;
  return Object.prototype.hasOwnProperty.call(USE_PROGRAMS, aliased) ? aliased : "generic";
}

const GENERIC_PROGRAM: UseProgram = {
  label: "Generic conversion",
  zones: [
    z("front", "Front-of-house", 8, "front"),
    z("work", "Workspace", 8, "work"),
    z("back", "Back-of-house", 4, "work"),
    z("wc", "WC", 2.7, "wet", ["wc", "toilet"]),
    z("store", "Storage", 3, "store"),
  ],
};

export function programFor(targetUse: string): UseProgram {
  const key = normaliseUse(targetUse);
  return USE_PROGRAMS[key] ?? GENERIC_PROGRAM;
}

/* ------------------------------------------------------------------ */
/* Space model from project memory                                     */
/* ------------------------------------------------------------------ */

export interface RoomShape {
  label: string;
  width: number; // m
  height: number; // m
  area: number; // m²
}

export interface ZoneAssignment {
  zone: ZoneDef;
  roomIndex: number;
  area: number; // allocated area, m²
  retained: boolean; // reuses an existing room vs a new sub-division
  tight: boolean; // allocated area below the indicative minimum
}

export interface ConceptDesign {
  targetUse: string;
  programLabel: string;
  totalFloorAreaM2: number;
  ceilingHeightM: number | null;
  rooms: RoomShape[];
  assignments: ZoneAssignment[];
  allocatedM2: number;
  circulationM2: number;
  circulationPct: number;
  notes: string[];
  svg: string;
}

/** Parse "4.5 x 3.2" → {width, height}. Returns null when malformed. */
function parseDim(value: string): { width: number; height: number } | null {
  const m = value.match(/([\d.]+)\s*[x×]\s*([\d.]+)/);
  if (!m) return null;
  const a = Number.parseFloat(m[1]);
  const b = Number.parseFloat(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return { width: a, height: b };
}

/**
 * Build the room model from intelligence facts. Room labels are paired with
 * room dimensions in document order — an explicit assumption, flagged in notes.
 */
function buildRooms(factRows: Array<{ key: string; value: string }>): RoomShape[] {
  const dims = factRows.filter((f) => f.key === "room_dimension_m").map((f) => parseDim(f.value));
  const labels = factRows.filter((f) => f.key === "room_label").map((f) => f.value);
  const rooms: RoomShape[] = [];
  dims.forEach((dim, i) => {
    if (!dim) return;
    rooms.push({
      label: labels[i] ? labels[i].toUpperCase() : `ROOM ${i + 1}`,
      width: dim.width,
      height: dim.height,
      area: Math.round(dim.width * dim.height * 10) / 10,
    });
  });
  return rooms;
}

/* ------------------------------------------------------------------ */
/* Zoning: assign programme zones to rooms deterministically           */
/* ------------------------------------------------------------------ */

function assignZones(program: UseProgram, rooms: RoomShape[]): { assignments: ZoneAssignment[]; notes: string[] } {
  const assignments: ZoneAssignment[] = [];
  const notes: string[] = [];
  // remaining capacity per room (starts at full room area)
  const remaining = rooms.map((r) => r.area);
  const used = rooms.map(() => false);
  const roomIdx = rooms.map((_, i) => i);

  // Pass 1 — affinity: put wet/service zones in the matching existing room.
  const affinityZones = program.zones.filter((z) => z.affinity && z.affinity.length > 0);
  for (const zone of affinityZones) {
    if (rooms.length === 0) break;
    const match = roomIdx
      .filter((i) => !used[i] && zone.affinity!.some((a) => rooms[i].label.toLowerCase().includes(a)))
      .sort((a, b) => rooms[a].area - rooms[b].area)[0];
    if (match === undefined) continue;
    const area = Math.min(zone.minArea, rooms[match].area);
    assignments.push({ zone, roomIndex: match, area: Math.round(area * 10) / 10, retained: true, tight: area < zone.minArea * 0.8 });
    remaining[match] = Math.max(0, remaining[match] - area);
    used[match] = true;
    if (area < zone.minArea * 0.8) notes.push(`${zone.name}: existing room (${rooms[match].label}) is smaller than the indicative minimum — tight fit.`);
  }

  // Pass 2 — remaining zones, front-of-house first, largest indicative areas next.
  const ordered = [...program.zones.filter((z) => !(z.affinity && z.affinity.length > 0) || !assignments.some((a) => a.zone.id === z.id))].sort(
    (a, b) => (a.zoneType === "front" ? -1 : 1) - (b.zoneType === "front" ? -1 : 1) || b.minArea - a.minArea,
  );

  for (const zone of ordered) {
    if (rooms.length === 0) {
      assignments.push({ zone, roomIndex: -1, area: zone.minArea, retained: false, tight: true });
      continue;
    }
    // Prefer the room with the most remaining capacity; then least-used for front zones.
    let target = -1;
    let bestCap = -1;
    for (let i = 0; i < rooms.length; i++) {
      if (remaining[i] <= 0) continue;
      if (remaining[i] > bestCap) {
        bestCap = remaining[i];
        target = i;
      }
    }
    if (target === -1) {
      // Everything allocated — put the zone on the largest room as a tight fit.
      const biggest = roomIdx.sort((a, b) => rooms[b].area - rooms[a].area)[0];
      const area = Math.round(rooms[biggest].area * 0.5 * 10) / 10;
      assignments.push({ zone, roomIndex: biggest, area, retained: false, tight: true });
      notes.push(`${zone.name}: no free floor area left — sketched as an overlay (tight fit).`);
      remaining[biggest] = Math.max(0, remaining[biggest] - area);
      continue;
    }
    const area = Math.min(zone.minArea, remaining[target]);
    const retained = used[target];
    assignments.push({ zone, roomIndex: target, area: Math.round(area * 10) / 10, retained, tight: area < zone.minArea * 0.8 });
    remaining[target] = Math.max(0, remaining[target] - area);
    used[target] = true;
    if (area < zone.minArea * 0.8) {
      notes.push(`${zone.name}: allocated ${Math.round(area)} m² against an indicative ${Math.round(zone.minArea)} m² — space is tight.`);
    }
  }

  return { assignments, notes };
}

/* ------------------------------------------------------------------ */
/* CAD-style SVG renderer                                              */
/* ------------------------------------------------------------------ */

const SCALE = 50; // px per metre (~1:50 on A4)
const TINT: Record<ZoneType, string> = {
  front: "#fdeed8",
  work: "#e3edfb",
  wet: "#d9f0e6",
  store: "#efe9e2",
};

function renderConceptSvg(c: {
  targetUse: string;
  programLabel: string;
  address: string;
  rooms: RoomShape[];
  assignments: ZoneAssignment[];
  ceilingHeightM: number | null;
  generatedAt: string;
}): string {
  const { rooms, assignments } = c;
  const gap = 26;
  const margin = 44;
  const dimGap = 34; // space below each room for the width dimension line
  const scaleBarH = 46;
  const titleH = 92;
  const topNoteH = 20;

  const roomW = (r: RoomShape) => Math.round(r.width * SCALE);
  const roomH = (r: RoomShape) => Math.round(r.height * SCALE);
  const maxH = rooms.reduce((m, r) => Math.max(m, roomH(r)), 0);

  const planW = rooms.reduce((acc, r, i) => acc + roomW(r) + (i > 0 ? gap : 0), 0);
  const width = margin * 2 + planW;
  const height = margin + topNoteH + maxH + dimGap + scaleBarH + titleH + margin;

  // ---- geometry helpers ----
  const roomX = (i: number) =>
    margin + rooms.slice(0, i).reduce((acc, r) => acc + roomW(r) + gap, 0);
  const roomTop = margin + topNoteH;

  // Zones grouped per room for split rendering.
  const zonesByRoom = new Map<number, ZoneAssignment[]>();
  for (const a of assignments) {
    if (a.roomIndex < 0) continue;
    const list = zonesByRoom.get(a.roomIndex) ?? [];
    list.push(a);
    zonesByRoom.set(a.roomIndex, list);
  }

  // ---- grid ----
  let grid = "";
  for (let gx = margin; gx <= margin + planW; gx += SCALE) {
    grid += `<line x1="${gx}" y1="${roomTop}" x2="${gx}" y2="${roomTop + maxH}" stroke="#ece7dc" stroke-width="0.6"/>`;
  }
  for (let gy = roomTop; gy <= roomTop + maxH; gy += SCALE) {
    grid += `<line x1="${margin}" y1="${gy}" x2="${margin + planW}" y2="${gy}" stroke="#ece7dc" stroke-width="0.6"/>`;
  }

  // ---- rooms + zones ----
  let roomsSvg = "";
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    const x = roomX(i);
    const y = roomTop;
    const w = roomW(r);
    const h = roomH(r);
    const cx = x + w / 2;

    // outer + inner wall
    roomsSvg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff" stroke="#101820" stroke-width="3"/>`;
    roomsSvg += `<rect x="${x + 5}" y="${y + 5}" width="${w - 10}" height="${h - 10}" fill="none" stroke="#101820" stroke-width="0.8"/>`;

    // room title + dims
    roomsSvg += `<text x="${cx}" y="${y + 17}" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="700" fill="#101820">${esc(r.label)}</text>`;
    roomsSvg += `<text x="${cx}" y="${y + 30}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="8.5" fill="#27323a">${r.width} × ${r.height} m · ${r.area} m²</text>`;

    // zones inside the room — widths proportional to room area so any
    // unallocated remainder is drawn honestly as circulation.
    const zlist = (zonesByRoom.get(i) ?? []).filter((a) => a.zone && a.zone.name);
    const innerX = x + 8;
    const innerW = Math.max(20, w - 16);
    const roomArea = Math.max(r.area, 0.01);
    let zx = innerX;
    if (zlist.length > 0) {
      zlist.forEach((a, zi) => {
        const zw = Math.max(18, Math.round((Math.max(a.area, 0.5) / roomArea) * innerW));
        const tint = TINT[a.zone.zoneType] ?? "#f5f5f0";
        roomsSvg += `<rect x="${zx}" y="${y + 36}" width="${zw}" height="${h - 48}" fill="${tint}" stroke="#8a8f94" stroke-width="0.7"/>`;
        // new partition (dashed) between zones
        if (zi < zlist.length - 1) {
          const px = zx + zw;
          roomsSvg += `<line x1="${px}" y1="${y + 34}" x2="${px}" y2="${y + h - 8}" stroke="#c98a4a" stroke-width="1.4" stroke-dasharray="6 4"/>`;
          roomsSvg += `<text x="${px}" y="${y + 34}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="6.5" fill="#c98a4a">NEW</text>`;
        }
        const lx = zx + zw / 2;
        roomsSvg += `<text x="${lx}" y="${y + h / 2 - 2}" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="8" font-weight="600" fill="#101820">${esc(a.zone.name)}</text>`;
        roomsSvg += `<text x="${lx}" y="${y + h / 2 + 9}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="7.5" fill="#27323a">${Math.round(a.area * 10) / 10} m²${a.tight ? " ⚠" : ""}</text>`;
        zx += zw;
      });
    }
    // circulation remainder inside this room
    const usedW = zx - innerX;
    const circW = innerW - usedW;
    if (circW >= 24) {
      roomsSvg += `<rect x="${zx}" y="${y + 36}" width="${circW}" height="${h - 48}" fill="#f8f6f1" stroke="#b9b2a4" stroke-width="0.6" stroke-dasharray="3 3"/>`;
      roomsSvg += `<text x="${zx + circW / 2}" y="${y + h / 2 + 3}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="7" fill="#8a8f94">CIRC</text>`;
    } else if (circW > 0) {
      // thin remainder — just the dashed boundary line
      roomsSvg += `<line x1="${zx}" y1="${y + 36}" x2="${zx}" y2="${y + h - 8}" stroke="#b9b2a4" stroke-width="0.6" stroke-dasharray="3 3"/>`;
    }

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
  const tb = `<g>
    <rect x="${margin}" y="${tbY}" width="${Math.min(planW + margin, 460)}" height="${titleH - 8}" fill="#ffffff" stroke="#101820" stroke-width="1.2"/>
    <text x="${margin + 12}" y="${tbY + 18}" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="700" fill="#101820">ATLAS AI — CONCEPT DESIGN</text>
    <text x="${margin + 12}" y="${tbY + 34}" font-family="'DM Sans',sans-serif" font-size="9.5" fill="#27323a">Target use: ${esc(c.programLabel)}</text>
    <text x="${margin + 12}" y="${tbY + 48}" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">${esc(c.address)}</text>
    <text x="${margin + 12}" y="${tbY + 62}" font-family="ui-monospace,Menlo,monospace" font-size="8" fill="#27323a">Generated ${esc(c.generatedAt)} · scale 1:50${c.ceilingHeightM ? ` · ceiling ${c.ceilingHeightM} m` : ""}</text>
    <text x="${margin + 12}" y="${tbY + 76}" font-family="ui-monospace,Menlo,monospace" font-size="7.5" fill="#8a5a1e">INDICATIVE ZONING CONCEPT — NOT FOR CONSTRUCTION. Verify with a measured survey.</text>
  </g>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="'DM Sans',ui-sans-serif,sans-serif" role="img" aria-label="Concept floor plan for ${esc(c.programLabel)}">
  ${grid}
  ${roomsSvg}
  ${scaleBar}
  ${north}
  ${tb}
  </svg>`;

  return svg;
}

/* ------------------------------------------------------------------ */
/* Public: full design step writing to project memory                  */
/* ------------------------------------------------------------------ */

export interface DesignStepOutput {
  note: string;
  facts: Array<{ category: string; key: string; value: string; confidence: number; sourceId: string | null }>;
  sources: Array<{ name: string; url: string | null; notes: string }>;
  design: ConceptDesign;
}

export async function runDesignStep(db: Db, projectId: string, targetUse: string): Promise<DesignStepOutput> {
  await ensureSchema();

  const [run] = await db`
    INSERT INTO pipeline_runs (project_id, step, status, started_at)
    VALUES (${projectId}, 'design', 'running', NOW())
    RETURNING id`;
  const runId = String(run.id);

  try {
    const [proj] = await db`SELECT address FROM projects WHERE id = ${projectId}`;
    if (!proj) throw new Error("project not found");

    const rows = await db`
      SELECT category, key, value FROM facts WHERE project_id = ${projectId}`;
    const factsAll = rows.map((r) => ({ category: String(r.category), key: String(r.key), value: String(r.value) }));
    const intel = factsAll.filter((f) => f.category === "intelligence");
    // Floor area: uploaded-document evidence wins; the EPC register fact
    // (auto-fetched in discovery) is the fallback so register-backed projects
    // still get a scaled concept sketch.
    const areaFact = intel.find((f) => f.key === "total_floor_area_m2") ?? factsAll.find((f) => f.category === "epc" && f.key === "total_floor_area_m2");
    const ceilingFact = intel.find((f) => f.key === "ceiling_height_m");
    let rooms = buildRooms(intel);
    if (rooms.length === 0 && areaFact && Number.parseFloat(areaFact.value) > 0) {
      // No room dimensions extracted — sketch the whole floor as one open plan
      // so the zoning concept still renders honestly as a suggestion.
      const a = Number.parseFloat(areaFact.value);
      const w = Math.round(Math.sqrt(a) * 10) / 10;
      rooms = [{ label: "OPEN PLAN", width: w, height: Math.round((a / w) * 10) / 10, area: Math.round(a * 10) / 10 }];
    }
    const roomsArea = rooms.reduce((acc, r) => acc + r.area, 0);
    const totalArea =
      areaFact && Number.parseFloat(areaFact.value) > 0
        ? Number.parseFloat(areaFact.value)
        : roomsArea > 0
          ? roomsArea
          : 0;
    const ceilingHeightM = ceilingFact ? Number.parseFloat(ceilingFact.value) : null;

    const programRaw = programFor(targetUse);
    // Scale the indicative programme to ~70% of the measured floor area so the
    // sketch reflects the space actually available (leaving 20–30% circulation
    // by design), clamped to a sensible band so degenerate inputs stay sane.
    const zoneSum = programRaw.zones.reduce((acc, z) => acc + z.minArea, 0);
    const targetAlloc = totalArea > 0 ? totalArea * 0.7 : zoneSum;
    const scale = totalArea > 0 ? Math.min(2.5, Math.max(0.8, targetAlloc / Math.max(zoneSum, 1))) : 1;
    const program: UseProgram = {
      label: programRaw.label,
      zones: programRaw.zones.map((z) => ({ ...z, minArea: Math.round(z.minArea * scale * 10) / 10 })),
    };
    const { assignments, notes } = assignZones(program, rooms);
    const allocatedM2 = Math.round(assignments.reduce((acc, a) => acc + a.area, 0) * 10) / 10;
    const circulationM2 = Math.round(Math.max(0, totalArea - allocatedM2) * 10) / 10;
    const circulationPct = totalArea > 0 ? Math.round((circulationM2 / totalArea) * 1000) / 10 : 0;

    const generatedAt = new Date().toISOString();
    const svg = renderConceptSvg({
      targetUse,
      programLabel: program.label,
      address: String(proj.address),
      rooms,
      assignments,
      ceilingHeightM,
      generatedAt: generatedAt.slice(0, 10),
    });

    // Resolve current use from the strongest available EPC class, then document text.
    const currentClassFact = factsAll.find((f) => f.category === "epc" && f.key === "use_class");
    const currentTextFact = factsAll.find((f) => /current.?use|property.?type/i.test(f.key));
    const currentClass = currentClassFact?.value?.trim() || (currentTextFact ? currentUseClass(currentTextFact.value) : null);
    const targetClass = targetUseClass(targetUse);
    const compliance = complianceVerdict(currentClass, targetClass);
    const allNotes = [
      `Concept zoning for "${program.label}" generated from confidence-scored space facts in project memory (intelligence step).`,
      rooms.length === 0
        ? "No room dimensions were extracted from uploaded documents — the sketch is an open-plan zoning suggestion only."
        : "Room labels are paired with dimensions in document order; verify the true layout with a measured survey.",
      `Circulation ${circulationPct}% of floor area left unallocated (typical 20–30%).`,
      "Indicative screening concept — NOT for construction, NOT a professional design, no planning/statutory compliance check.",
      ...notes,
    ].join(" ");

    const [src] = await db`
      INSERT INTO sources (project_id, name, url, notes)
      VALUES (${projectId}, 'ATLAS AI concept design', NULL,
        'Rule-based zoning concept generated from project-memory space facts and an indicative target-use programme. Assumptions: room-label/dimension pairing in document order; circulation 20–30%; screening-level zone sizes. Advisory only — not for construction.')
      RETURNING id`;
    const sourceId = String(src.id);

    const factOuts: Array<{ category: string; key: string; value: string; confidence: number; sourceId: string | null }> = [
      { category: "design", key: "design_target_use", value: targetUse, confidence: 0.95, sourceId },
      { category: "design", key: "design_program_label", value: program.label, confidence: 0.9, sourceId },
      { category: "design", key: "design_status", value: "generated", confidence: 1, sourceId },
      { category: "design", key: "design_generated_at", value: generatedAt, confidence: 1, sourceId },
      { category: "design", key: "design_total_floor_area_m2", value: String(totalArea), confidence: areaFact ? 0.8 : 0.5, sourceId },
      { category: "design", key: "design_rooms_count", value: String(rooms.length), confidence: 0.8, sourceId },
      { category: "design", key: "design_allocated_m2", value: String(allocatedM2), confidence: 0.55, sourceId },
      { category: "design", key: "design_circulation_pct", value: String(circulationPct), confidence: 0.5, sourceId },
      {
        category: "design",
        key: "design_zones",
        value: JSON.stringify(
          assignments.map((a) => ({
            zone: a.zone.name,
            room: a.roomIndex >= 0 && rooms[a.roomIndex] ? rooms[a.roomIndex].label : "no room",
            area_m2: a.area,
            retained: a.retained,
            tight: a.tight,
          })),
        ),
        confidence: 0.55,
        sourceId,
      },
      { category: "design", key: "design_assumptions", value: allNotes, confidence: 0.9, sourceId },
      { category: "design", key: "design_concept_svg", value: svg, confidence: 0.5, sourceId },
      { category: "compliance", key: "current_use_class", value: currentClass ?? "unknown", confidence: currentClassFact ? 0.95 : currentClass ? 0.65 : 0.25, sourceId },
      { category: "compliance", key: "target_use_class", value: targetClass ?? "unknown", confidence: targetClass ? 0.9 : 0.25, sourceId },
      { category: "compliance", key: "change_of_use_permission_required", value: compliance.permission, confidence: compliance.confidence, sourceId },
      { category: "compliance", key: "verdict_note", value: compliance.note, confidence: compliance.confidence, sourceId },
    ];
    for (const f of factOuts) {
      await db`
        INSERT INTO facts (project_id, category, key, value, confidence, source_id)
        VALUES (${projectId}, ${f.category}, ${f.key}, ${f.value}, ${f.confidence}, ${f.sourceId})`;
    }

    await db`
      INSERT INTO decisions (project_id, step, choice, rationale)
      VALUES (${projectId}, 'design', ${targetUse},
        'User-selected target use for the concept design step; zoning generated from project-memory space facts.')`;

    await db`
      UPDATE pipeline_runs SET status = 'done', finished_at = NOW(), error = NULL WHERE id = ${runId}`;

    const design: ConceptDesign = {
      targetUse,
      programLabel: program.label,
      totalFloorAreaM2: Math.round(totalArea * 10) / 10,
      ceilingHeightM,
      rooms,
      assignments,
      allocatedM2,
      circulationM2,
      circulationPct,
      notes: allNotes.split(". "),
      svg,
    };

    return {
      note: `Concept design generated for "${program.label}": ${rooms.length} room(s), ${allocatedM2} m² allocated, ${circulationPct}% circulation. Indicative only — see report.`,
      facts: factOuts,
      sources: [{ name: "ATLAS AI concept design", url: null, notes: "Rule-based zoning concept; advisory only." }],
      design,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db`
      UPDATE pipeline_runs SET status = 'error', finished_at = NOW(), error = ${message} WHERE id = ${runId}`;
    throw err;
  }
}
