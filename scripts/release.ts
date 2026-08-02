import { randomBytes } from "node:crypto";
import { sql } from "../src/db";
import { ensureSchema } from "../src/project-schema";

const id = process.argv[2];
if (!process.env.ADMIN_TOKEN) throw new Error("Set ADMIN_TOKEN before releasing a project");
if (!id || !/^\d+$/.test(id)) throw new Error("Usage: ADMIN_TOKEN=... bun run release <projectId>");
await ensureSchema();
const token = randomBytes(32).toString("base64url");
const rows = await sql()`UPDATE projects SET release_token = ${token}, updated_at = NOW() WHERE id = ${id} RETURNING id`;
if (!rows.length) throw new Error(`Project ${id} not found`);
console.log(`https://atlasai.ctonew.app/report/${id}?token=${token}`);
