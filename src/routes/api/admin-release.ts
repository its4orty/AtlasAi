import { createFileRoute } from "@tanstack/react-router";
import { randomBytes } from "node:crypto";
import { sql } from "~/db";
import { ensureSchema } from "~/project-schema";
export const Route = createFileRoute("/api/admin-release")({ server: { handlers: { POST: async ({ request }) => {
 const expected=process.env.ADMIN_TOKEN?.trim(), supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim(); if (!expected || supplied!==expected) return Response.json({error:"unauthorised"},{status:401});
 const body=await request.json().catch(()=>({})) as {projectId?:string}; const id=String(body.projectId??""); if(!/^\d+$/.test(id)) return Response.json({error:"projectId must be numeric"},{status:400}); await ensureSchema(); const token=randomBytes(32).toString("base64url"); const rows=await sql()`UPDATE projects SET release_token=${token},updated_at=NOW() WHERE id=${id} RETURNING id`; if(!rows.length)return Response.json({error:"project not found"},{status:404}); return Response.json({projectId:id,token,unlockUrl:`https://atlasai.ctonew.app/report/${id}?token=${token}`});
} } } });
