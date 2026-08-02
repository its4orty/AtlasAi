/** Deterministic, code-only axonometric schematic renderer. Geometry is limited to supplied rooms. */
export interface AxoRoom { label: string; width: number; height: number; area: number }
export interface AxoOptions { title: string; address: string; rooms: AxoRoom[]; newLabels?: string[]; footprintOnly?: boolean; ceilingHeightM?: number | null; generatedAt?: string }
const esc=(v:unknown)=>String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const n=(v:number)=>Math.round(v*10)/10;
/** x/y are plan metres; z is rendered vertical pixels. */
export function renderAxonometric(o:AxoOptions):string {
 const rooms=o.rooms.length?o.rooms:[{label:"NO SPACE EVIDENCE",width:1,height:1,area:1}];
 const S=38, H= o.ceilingHeightM && o.ceilingHeightM>0 ? Math.min(130,Math.max(75,o.ceilingHeightM*32)):90;
 const gap=.35, margin=52; let x=0; const boxes=rooms.map(r=>{const b={r,x,y:0,w:r.width,h:r.height}; x+=r.width+gap; return b});
 const proj=(x:number,y:number,z:number)=>({x:(x-y)*S,y:(x+y)*S*.5-z});
 const pts=(b:any,z:number)=>[proj(b.x,b.y,z),proj(b.x+b.w,b.y,z),proj(b.x+b.w,b.y+b.h,z),proj(b.x,b.y+b.h,z)];
 const all=boxes.flatMap(b=>[...pts(b,0),...pts(b,H)]); const minX=Math.min(...all.map(p=>p.x)),maxX=Math.max(...all.map(p=>p.x)); const minY=Math.min(...all.map(p=>p.y)),maxY=Math.max(...all.map(p=>p.y));
 const W=Math.ceil(maxX-minX+margin*2), planH=Math.ceil(maxY-minY+margin*2), titleH=76, height=planH+titleH+margin;
 const tr=(p:any)=>`${n(p.x-minX+margin)},${n(p.y-minY+margin)}`; const poly=(ps:any[],fill:string,stroke="#101820",dash="")=>`<polygon points="${ps.map(tr).join(" ")}" fill="${fill}" stroke="${stroke}" stroke-width="1.8" ${dash?`stroke-dasharray="${dash}"`:""}/>`;
 let svg="";
 boxes.forEach((b,i)=>{const top=pts(b,H), bot=pts(b,0); svg+=poly(bot,"#f4f0e8"); svg+=poly([top[0],top[1],bot[1],bot[0]],"#d9d0c1"); svg+=poly([top[1],top[2],bot[2],bot[1]],"#c5b9a8"); svg+=poly(top,"#fffdf8"); const c=top.reduce((a:any,p:any)=>({x:a.x+p.x/4,y:a.y+p.y/4}),{x:0,y:0}); svg+=`<text x="${n(c.x-minX+margin)}" y="${n(c.y-minY+margin+3)}" text-anchor="middle" font-family="'DM Sans',sans-serif" font-size="9" font-weight="700" fill="#101820">${esc(b.r.label)}</text>`; svg+=`<text x="${n(c.x-minX+margin)}" y="${n(c.y-minY+margin+15)}" text-anchor="middle" font-family="ui-monospace,monospace" font-size="7.5" fill="#27323a">${b.r.width} × ${b.r.height} m · ${b.r.area} m²</text>`; if(o.newLabels?.[i]) svg+=`<line x1="${tr(top[0]).split(",")[0]}" y1="${tr(top[0]).split(",")[1]}" x2="${tr(top[3]).split(",")[0]}" y2="${tr(top[3]).split(",")[1]}" stroke="#c98a4a" stroke-width="2" stroke-dasharray="6 4"/>`; });
 const sb=margin, sy=planH-22; svg+=`<line x1="${sb}" y1="${sy}" x2="${sb+5*S}" y2="${sy}" stroke="#101820"/><text x="${sb}" y="${sy-6}" font-family="ui-monospace,monospace" font-size="8" fill="#27323a">SCALE 1:50 · 0–5 m</text>`;
 const tb=planH+12; svg+=`<rect x="${margin}" y="${tb}" width="${Math.min(W-2*margin,520)}" height="${titleH-8}" fill="#fff" stroke="#101820"/><text x="${margin+10}" y="${tb+17}" font-family="'DM Sans',sans-serif" font-size="10.5" font-weight="700">ATLAS AI — ${esc(o.title)} · AXONOMETRIC</text><text x="${margin+10}" y="${tb+33}" font-family="ui-monospace,monospace" font-size="8">${esc(o.address)}</text><text x="${margin+10}" y="${tb+47}" font-family="ui-monospace,monospace" font-size="8">${o.footprintOnly?"FOOTPRINT EXTRUSION — AREA ONLY; SHAPE ILLUSTRATIVE":"Schematic extrusion from project-memory room evidence"}${o.generatedAt?` · ${esc(o.generatedAt)}`:""}</text><text x="${margin+10}" y="${tb+61}" font-family="ui-monospace,monospace" font-size="7.5" fill="#8a5a1e">INDICATIVE 3D-STYLE VIEW — NOT FOR CONSTRUCTION OR PHOTOREALISTIC.</text>`;
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" role="img" aria-label="3D-style axonometric view of ${esc(o.title)}">${svg}</svg>`;
}
