import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/")({ component: Home });

const professions = ["Property developers", "Investors", "Architects", "Surveyors", "Planning consultants", "Housing associations", "Local authorities", "Asset managers"];
const deliverables = [
  ["01", "Evidence-backed digital twin", "A source-traceable picture of the site, context and constraints."],
  ["02", "Redevelopment concepts", "Multiple options to explore what the property could become."],
  ["03", "Financial feasibility model", "ROI, cashflow and sensitivity analysis for each direction."],
  ["04", "Investor-ready reports", "Memorandum, business plan and financial pack in one workflow."],
  ["05", "Photorealistic visualisations", "Believable imagery to make the opportunity tangible."],
  ["06", "Authorised document & data gathering", "Publicly available and authorised sources, assembled with care."],
];
const workflow = [
  ["01", "Address in", "A single property address starts the project."],
  ["02", "Evidence gathering", "Planning, zoning, title, market and site data gathered."],
  ["03", "Digital twin", "Constraints and opportunity mapped into a shared view."],
  ["04", "Concepts & financials", "Massing options paired with pro-forma returns."],
  ["05", "Investor pack", "Export-ready documentation for the next conversation."],
];

function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setStatus("submitting");
    try { const r = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }); setStatus(r.ok ? "success" : "error"); }
    catch { setStatus("error"); }
  }
  return <form className="waitlist-form" onSubmit={submit} aria-label="Join the ATLAS AI waitlist">
    <label htmlFor="email">Email address</label><div className="form-row"><input id="email" type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" disabled={status === "submitting"} /><button type="submit" disabled={status === "submitting"}>{status === "submitting" ? "Joining…" : "Join the waitlist"}</button></div>
    <p className="form-note" aria-live="polite">{status === "success" ? "Thanks — you're on the list." : status === "error" ? "We couldn't add you right now. Please try again." : "Early access is rolling out to a limited cohort. No spam — unsubscribe anytime."}</p>
  </form>;
}

function Home() {
  const [address, setAddress] = useState("123 High Street"); const [showReport, setShowReport] = useState(false); const [active, setActive] = useState(0);
  return <main>
    <nav className="nav container"><a href="#top" className="logo"><img src="/brand/atlas-logo.svg" alt="ATLAS AI" /></a><span className="nav-links"><a className="nav-link" href="/analyse">Analyse a property <span>↗</span></a><a className="nav-link" href="#waitlist">Join the waitlist <span>↗</span></a></span></nav>
    <section className="hero" id="top"><img className="hero-image" src="/images/hero-transformation.webp" alt="Architectural transformation visualisation" width="1536" height="1024" fetchPriority="high" /><div className="hero-inner container"><div className="hero-copy"><p className="eyebrow">AI property intelligence for developers &amp; investors</p><h1>One address. A complete redevelopment feasibility study.</h1><p className="hero-sub">ATLAS AI assembles an evidence-backed digital twin, redevelopment concepts, financial models and an investor-ready pack — in minutes, not weeks.</p><a className="button" href="#waitlist">Join the waitlist <span>↗</span></a></div><div className="address-card"><p className="card-kicker">START WITH AN ADDRESS</p><div className="address-input"><input aria-label="Property address" value={address} onChange={e => setAddress(e.target.value)} /><button onClick={() => setShowReport(true)} aria-label="Generate sample report">→</button></div>{showReport && <div className="report"><div className="report-head"><strong>Sample output</strong><span>FEASIBILITY / 01</span></div><p className="report-address">{address || "123 High Street"}</p><div className="report-grid"><span>ZONING<strong>Residential</strong></span><span>CONSTRAINTS<strong>Mapped</strong></span><span>MASSING CONCEPT<strong>3 options</strong></span><span>PRO-FORMA<strong>Ready</strong></span></div></div>}</div></div></section>
    <section className="built"><div className="container built-inner"><p className="section-label">BUILT FOR</p><div className="profession-list">{professions.map(p => <span key={p}>{p}</span>)}</div></div></section>
    <section className="light-section old-way"><div className="container"><div className="section-intro"><p className="section-label">THE OLD WAY</p><h2>Good decisions start with better intelligence.</h2><p>Property feasibility is still stitched together by hand — slowly, expensively and with gaps in the picture.</p></div><div className="pain-grid">{["Information is fragmented across dozens of websites and documents", "Early feasibility studies are expensive and time-consuming", "Investors make decisions with incomplete information — and every project starts almost from scratch."].map((x,i)=><article className="pain-card" key={x}><span>0{i+1}</span><h3>{x}</h3></article>)}</div></div></section>
    <section className="light-section deliver"><div className="container"><div className="section-intro"><p className="section-label">WHAT YOU GET</p><h2>From raw address to considered opportunity.</h2></div><div className="deliver-grid">{deliverables.map(([n,t,d])=><article key={t}><span className="number">{n}</span><h3>{t}</h3><p>{d}</p></article>)}</div></div></section>
    <section className="difference"><div className="container"><p className="section-label">WHY IT'S DIFFERENT</p><blockquote>Most software helps professionals design buildings. <em>ATLAS AI helps professionals decide what a building should become</em> — before detailed design even begins.</blockquote><p className="difference-note">Property intelligence, AI reasoning, concept design, financial modelling and presentation in one integrated workflow.</p></div></section>
    <section className="gallery" data-gallery="sample-visualisations"><div className="container"><div className="section-intro"><p className="section-label">SAMPLE VISUALISATIONS</p><h2>From address to opportunity.</h2><p>Illustrative architectural renders showing the kinds of visual outputs ATLAS AI can support.</p></div><div className="gallery-grid"><figure><img src="/images/render-exterior-dusk.webp" alt="Illustrative exterior architectural render at dusk" width="1536" height="1024" loading="lazy" /><figcaption><span>01 / EXTERIOR</span>Illustrative exterior study at dusk.</figcaption></figure><figure><img src="/images/render-interior-loft.webp" alt="Illustrative loft interior architectural render" width="1536" height="1024" loading="lazy" /><figcaption><span>02 / INTERIOR</span>Illustrative loft interior study.</figcaption></figure><figure><img src="/images/digital-twin-overlay.webp" alt="Illustrative digital twin overlay of a property" width="1536" height="1024" loading="lazy" /><figcaption><span>03 / DIGITAL TWIN</span>Illustrative digital twin overlay.</figcaption></figure></div></div></section>
    <section className="workflow light-section"><div className="container workflow-layout"><div className="section-intro"><p className="section-label">HOW IT WORKS</p><h2>A clear path from evidence to action.</h2><p>Every step traceable to source — nothing is a black box.</p></div><div className="steps">{workflow.map(([n,t,d],i)=><button className={active===i ? "step active" : "step"} onClick={()=>setActive(i)} key={n}><span>{n}</span><div><h3>{t}</h3><p>{d}</p></div></button>)}</div><div className="artifact"><p className="section-label">SAMPLE ARTIFACT / {workflow[active][0]}</p><h3>{workflow[active][1]}</h3><div className="artifact-lines"><i/><i/><i/><i/></div><small>{workflow[active][2]}</small></div></div></section>
    <section className="final-cta" id="waitlist"><div className="container cta-inner"><p className="section-label">EARLY ACCESS</p><h2>Ready to see what your address could become?</h2><WaitlistForm/></div></section>
    <section className="faq light-section"><div className="container"><p className="section-label">QUESTIONS</p><div className="faq-grid"><details><summary>What does it cost?</summary><p>Early-access pricing is shared with the cohort.</p></details><details><summary>Where does the data come from?</summary><p>Publicly available and authorised sources, with every figure traceable.</p></details><details><summary>Is my data private?</summary><p>Yes. Your project data is private — never used to train models.</p></details><details><summary>Who is it for?</summary><p>Property developers, investors, architects, surveyors, planning consultants, housing associations, local authorities and asset managers.</p></details></div></div></section>
    <footer><div className="container footer-inner"><img src="/brand/atlas-logo.svg" alt="ATLAS AI" /><p>Address to opportunity.</p><span>© 2026 ATLAS AI · Your project data is private — never used to train models.</span></div></footer>
  </main>;
}
