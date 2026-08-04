import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
import { buildStreetViewEmbedUrl, geocodeAddress } from "~/streetview";

type Db = ReturnType<typeof sql>;
export async function getConfirmation(db: Db, projectId: string) {
  await ensureSchema();
  const [project] = await db`SELECT id,address FROM projects WHERE id=${projectId}`;
  if (!project) throw new Error("project not found");
  const facts = await db`SELECT category,key,value FROM facts WHERE project_id=${projectId} ORDER BY id`;
  const get = (key: string) => facts.find((f) => String(f.key) === key)?.value ? String(facts.find((f) => String(f.key) === key)!.value) : null;
  let lat = get("coords_lat") ?? get("imagery_streetview_lat") ?? get("latitude");
  let lon = get("coords_lon") ?? get("imagery_streetview_lon") ?? get("longitude");
  const address = String(project.address);
  let embed = get("imagery_streetview_embed_url");
  if (!embed && lat && lon) embed = buildStreetViewEmbedUrl(address, lat, lon);
  const [decision] = await db`SELECT id,choice,rationale,created_at FROM decisions WHERE project_id=${projectId} AND step='confirm' ORDER BY id DESC LIMIT 1`;
  return { address, coords: lat && lon ? { lat: Number(lat), lon: Number(lon) } : null, streetviewEmbedUrl: embed, status: decision ? "confirmed" : "unconfirmed", decision: decision ? { id: String(decision.id), choice: String(decision.choice), rationale: decision.rationale, createdAt: String(decision.created_at) } : undefined };
}
export async function confirmProperty(db: Db, projectId: string, input: { decision: "yes"|"pin"; lat?: number; lon?: number; rationale?: string }) {
  await ensureSchema();
  const [project] = await db`SELECT address FROM projects WHERE id=${projectId}`;
  if (!project) throw new Error("project not found");
  let lat: string | null = null, lon: string | null = null;
  if (input.decision === "pin") {
    if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon) || Math.abs(input.lat!) > 90 || Math.abs(input.lon!) > 180) throw new Error("invalid pin coordinates");
    lat = String(input.lat); lon = String(input.lon);
  } else {
    const current = await getConfirmation(db, projectId); lat = current.coords ? String(current.coords.lat) : null; lon = current.coords ? String(current.coords.lon) : null;
  }
  const choice = input.decision === "pin" ? `pin:${lat},${lon}` : "yes";
  await db`INSERT INTO decisions (project_id,step,choice,rationale) VALUES (${projectId},'confirm',${choice},${input.rationale ?? "Client confirmed the property reference."})`;
  const [source] = await db`INSERT INTO sources (project_id,name,url,notes) VALUES (${projectId},'Client property confirmation',NULL,'Client-confirmed property reference; Street View is a live Google preview.') RETURNING id`;
  const sid = source.id;
  const add = async (category: string, key: string, value: string) => db`INSERT INTO facts (project_id,category,key,value,confidence,source_id) VALUES (${projectId},${category},${key},${value},1,${sid})`;
  await add("confirmation", "coords_confirmed", "yes"); await add("confirmation", "coords_source", "client-confirmed");
  if (lat && lon) { await add("confirmation", "coords_lat", lat); await add("confirmation", "coords_lon", lon); await add("imagery", "imagery_streetview_lat", lat); await add("imagery", "imagery_streetview_lon", lon); await add("imagery", "imagery_streetview_embed_url", buildStreetViewEmbedUrl(String(project.address), lat, lon)); await add("imagery", "imagery_streetview_status", "embed"); }
  if (input.decision === "pin") { await add("confirmation", "downstream_rerun_required", "discovery,epc,nearby"); await add("confirmation", "pin_source", "client pin"); }
  return getConfirmation(db, projectId);
}
export function schematicElevationSvg(address: string, lat: string, lon: string) {
  const safe = address.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 420"><rect width="900" height="420" fill="#f6f3ed"/><path d="M100 330h700M180 330V150h540v180M180 150l90-55h360l90 55M260 330V205h110v125M530 330V205h110v125" fill="none" stroke="#17221f" stroke-width="6"/><text x="450" y="45" text-anchor="middle" font-family="sans-serif" font-size="24" font-weight="bold">SCHEMATIC FRONT ELEVATION</text><text x="450" y="380" text-anchor="middle" font-family="sans-serif" font-size="17">Schematic elevation from confirmed property reference — not a measured survey</text><text x="25" y="30" font-family="sans-serif" font-size="14">N ↑</text><text x="25" y="405" font-family="sans-serif" font-size="12">Confirmed reference: ${safe} · ${lat}, ${lon}</text></svg>`;
}
