import { createFileRoute } from "@tanstack/react-router";
import { sql } from "~/db";
import { getConfirmation, confirmProperty } from "~/confirm";
export const Route = createFileRoute("/api/confirm/$projectId")({ server:{handlers:{
 GET: async ({params})=>{try{return Response.json(await getConfirmation(sql(),String(params.projectId)))}catch(e){return Response.json({error:e instanceof Error?e.message:"not found"},{status:404})}},
 POST: async ({params,request})=>{try{const b=await request.json() as any; if(!['yes','pin'].includes(b.decision)) return Response.json({error:'decision must be yes or pin'},{status:400}); return Response.json(await confirmProperty(sql(),String(params.projectId),{decision:b.decision,lat:b.lat,lon:b.lon,rationale:b.rationale}))}catch(e){return Response.json({error:e instanceof Error?e.message:'confirmation failed'},{status:400})}}
}}});
