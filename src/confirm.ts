import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { buildStreetViewEmbedUrl, reverseGeocodeAddress } from "~/streetview";
import { runNearbyScan } from "~/nearby";

type Db = ReturnType<typeof sql>;
export async function getConfirmation(db: Db, projectId: string) {
  await ensureSchema();
  const [project] = await db`SELECT id,address FROM projects WHERE id=${projectId}`;
  if (!project) throw new Error("project not found");
  const facts = await db`SELECT category,key,value FROM facts WHERE project_id=${projectId} ORDER BY id`;
  // Latest fact for a key wins: facts accumulate over time (original discovery, then client pin corrections).
  const get = (key: string) => { for (let i = facts.length - 1; i >= 0; i--) { if (String(facts[i].key) === key && facts[i].value) return String(facts[i].value); } return null; };
  const lat = get("coords_lat") ?? get("imagery_streetview_lat") ?? get("latitude");
  const lon = get("coords_lon") ?? get("imagery_streetview_lon") ?? get("longitude");
  const address = String(project.address);
  let embed = get("imagery_streetview_embed_url");
  if (!embed && lat && lon) embed = buildStreetViewEmbedUrl(address, lat, lon);
  // Only the LATEST confirm decision counts: a pin correction after a yes invalidates the confirmation.
  const [latest] = await db`SELECT id,choice,rationale,created_at FROM decisions WHERE project_id=${projectId} AND step='confirm' ORDER BY id DESC LIMIT 1`;
  const confirmed = isConfirmedByLatestDecision(latest?.choice);
  return { address, coords: lat && lon ? { lat: Number(lat), lon: Number(lon) } : null, streetviewEmbedUrl: embed, status: confirmed ? "confirmed" : "unconfirmed", decision: latest ? { id: String(latest.id), choice: String(latest.choice), rationale: latest.rationale, createdAt: String(latest.created_at) } : undefined };
}
/** Hard-gate rule: a project is confirmed only if its most recent confirmation decision is an explicit "yes". */
export function isConfirmedByLatestDecision(latestChoice: string | null | undefined): boolean {
  return latestChoice === "yes";
}

export async function confirmProperty(db: Db, projectId: string, input: { decision: "yes"|"pin"; lat?: number; lon?: number; rationale?: string }) {
  await ensureSchema();
  const [project] = await db`SELECT address FROM projects WHERE id=${projectId}`;
  if (!project) throw new Error("project not found");
  let lat: string | null = null, lon: string | null = null;
  if (input.decision === "pin") {
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon) || Math.abs(input.lat!) > 90 || Math.abs(input.lon!) > 180) throw new Error("invalid pin coordinates");
    lat = String(input.lat); lon = String(input.lon);
    const resolved = await reverseGeocodeAddress(input.lat!, input.lon!);
    const correctedAddress = resolved ?? `Corrected location: ${lat}, ${lon}`;
    const sourceNote = resolved ? `Client pin correction; reverse-geocoded by Nominatim to ${correctedAddress}.` : `Client pin correction; address resolution failed, retaining coordinates as the display address (${lat}, ${lon}).`;
    await db`UPDATE projects SET address=${correctedAddress} WHERE id=${projectId}`;
    const [source] = await db`INSERT INTO sources (project_id,name,url,notes) VALUES (${projectId},'Client corrected property location','https://nominatim.openstreetmap.org/reverse',${sourceNote}) RETURNING id`;
    const sid = source.id;
    const add = async (category: string, key: string, value: string, confidence = 1) => db`INSERT INTO facts (project_id,category,key,value,confidence,source_id) VALUES (${projectId},${category},${key},${value},${confidence},${sid})`;
    await add("confirmation", "coords_lat", lat); await add("confirmation", "coords_lon", lon); await add("confirmation", "coords_source", "client-pin"); await add("confirmation", "address_corrected", correctedAddress, resolved ? .9 : .5);
    await add("imagery", "imagery_streetview_lat", lat); await add("imagery", "imagery_streetview_lon", lon); await add("imagery", "imagery_streetview_embed_url", buildStreetViewEmbedUrl(correctedAddress, lat, lon)); await add("imagery", "imagery_streetview_status", "embed");
    // Bounded nearby refresh: one postcode lookup and capped providers; never a full pipeline rerun.
    const postcode = correctedAddress.match(/\b[A-Z]{1,2}\d[A-Z0-9]?\s*\d[A-Z]{2}\b/i)?.[0] ?? null;
    const nearby = await runNearbyScan({ postcode, lat: input.lat!, lon: input.lon!, floorAreaM2: null, targetUse: "commercial", sourceId: sid, generatedAt: new Date().toISOString() });
    for (const f of nearby) await add(f.category, f.key, f.value, f.confidence);
    await db`INSERT INTO decisions (project_id,step,choice,rationale) VALUES (${projectId},'confirm',${`pin:${lat},${lon}`},${input.rationale ?? "Client selected a corrected map pin; fresh property confirmation required."})`;
    return getConfirmation(db, projectId);
  }
  const current = await getConfirmation(db, projectId); lat = current.coords ? String(current.coords.lat) : null; lon = current.coords ? String(current.coords.lon) : null;
  const choice = "yes";
  await db`INSERT INTO decisions (project_id,step,choice,rationale) VALUES (${projectId},'confirm',${choice},${input.rationale ?? "Client confirmed the property reference."})`;
  const [source] = await db`INSERT INTO sources (project_id,name,url,notes) VALUES (${projectId},'Client property confirmation',NULL,'Client-confirmed property reference; Street View is a live Google preview.') RETURNING id`;
  const sid = source.id;
  const add = async (category: string, key: string, value: string) => db`INSERT INTO facts (project_id,category,key,value,confidence,source_id) VALUES (${projectId},${category},${key},${value},1,${sid})`;
  await add("confirmation", "coords_confirmed", "yes"); await add("confirmation", "coords_source", "client-confirmed");
  if (lat && lon) { await add("confirmation", "coords_lat", lat); await add("confirmation", "coords_lon", lon); await add("imagery", "imagery_streetview_lat", lat); await add("imagery", "imagery_streetview_lon", lon); await add("imagery", "imagery_streetview_embed_url", buildStreetViewEmbedUrl(String(project.address), lat, lon)); await add("imagery", "imagery_streetview_status", "embed"); }
  return getConfirmation(db, projectId);
}
export function schematicElevationSvg(address: string, lat: string, lon: string) {
  const safe = address.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 420"><rect width="900" height="420" fill="#f6f3ed"/><path d="M100 330h700M180 330V150h540v180M180 150l90-55h360l90 55M260 330V205h110v125M530 330V205h110v125" fill="none" stroke="#17221f" stroke-width="6"/><text x="450" y="45" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="bold">SCHEMATIC FRONT ELEVATION</text><text x="450" y="380" text-anchor="middle" font-family="sans-serif" font-size="17">Schematic elevation from confirmed property reference — not a measured survey</text><text x="25" y="30" font-family="sans-serif" font-size="14">N ↑</text><text x="25" y="405" font-family="sans-serif" font-size="12">Confirmed reference: ${safe} · ${lat}, ${lon}</text></svg>`;
}
