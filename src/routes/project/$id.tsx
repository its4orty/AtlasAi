import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * /project/$id — full project memory view: project row, pipeline step
 * statuses, extracted facts (with confidence + provenance), sources and any
 * recorded decisions. Demonstrates "resume where you left off / everything
 * traceable": the page renders whatever the project memory contains.
 */
export const Route = createFileRoute("/project/$id")({ component: ProjectView });

interface StepRow {
  id: string;
  step: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface FactRow {
  id: string;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source_id: string | null;
  source_name: string | null;
}

interface SourceRow {
  id: string;
  name: string;
  url: string | null;
  fetched_at: string | null;
  notes: string | null;
}

interface DecisionRow {
  id: string;
  step: string;
  choice: string;
  rationale: string | null;
  created_at: string | null;
}

interface ProjectMemory {
  project: { id: string; address: string; status: string; created_at: string | null; updated_at: string | null };
  runs: StepRow[];
  facts: FactRow[];
  sources: SourceRow[];
  decisions: DecisionRow[];
}

const STEP_TITLES: Record<string, string> = {
  normalise: "Address normalisation & validation",
  discovery: "Property discovery",
  collection: "Document collection",
  intelligence: "Document intelligence",
  feasibility: "Financial feasibility",
  report: "Report generation",
};

function Badge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

function fmtTimestamp(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toUTCString().replace("GMT", "UTC");
}

function ProjectView() {
  const { id } = Route.useParams();
  const [state, setState] = useState<{ loading: boolean; data: ProjectMemory | null; error: string }>({
    loading: true,
    data: null,
    error: "",
  });

  const [uploading, setUploading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [rerunMessage, setRerunMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null, error: "" });
    fetch(`/api/project?id=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Could not load project");
        if (!cancelled) setState({ loading: false, data: d as ProjectMemory, error: "" });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            loading: false,
            data: null,
            error: err instanceof Error ? err.message : "Could not load project",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function uploadEvidence(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("evidence") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || uploading) return;
    setUploading(true); setUploadError(""); setRerunMessage("");
    try {
      const form = new FormData(); form.append("projectId", id); form.append("file", file);
      const r = await fetch("/api/documents", { method: "POST", body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Upload failed — please try again.");
      setUploadedFile(d.filename ?? file.name); input.value = "";
    } catch (err) { setUploadError(err instanceof Error ? err.message : "Upload failed — please try again."); }
    finally { setUploading(false); }
  }
  async function rerunAnalysis() {
    if (rerunning) return;
    setRerunning(true); setUploadError(""); setRerunMessage("");
    try {
      const r = await fetch("/api/analyse", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: id }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Re-run failed — please try again.");
      setRerunMessage("Analysis re-run complete — project memory refreshed.");
      const refreshed = await fetch(`/api/project?id=${encodeURIComponent(id)}`); const memory = await refreshed.json();
      if (!refreshed.ok) throw new Error(memory.error ?? "Could not refresh project");
      setState({ loading: false, data: memory as ProjectMemory, error: "" });
    } catch (err) { setUploadError(err instanceof Error ? err.message : "Re-run failed — please try again."); }
    finally { setRerunning(false); }
  }

  return (
    <div className="app-page">
      <header className="app-nav">
        <div className="container nav-inner">
          <a href="/" className="logo">
            <img src="/brand/atlas-logo.svg" alt="ATLAS AI" />
          </a>
          <a className="nav-link" href="/analyse">
            New analysis <span>↗</span>
          </a>
        </div>
      </header>

      <main className="app-body container">
        {state.loading && (
          <>
            <p className="section-label">PROJECT MEMORY</p>
            <p className="app-lead">Loading project #{id}…</p>
          </>
        )}

        {!state.loading && state.error && (
          <>
            <p className="section-label">PROJECT MEMORY</p>
            <h1>Project not found.</h1>
            <p className="app-lead">{state.error}</p>
            <p style={{ marginTop: 26 }}>
              <a className="link-back" href="/analyse">
                Start a new analysis ↗
              </a>
            </p>
          </>
        )}

        {!state.loading && state.data && (
          <>
            <p className="section-label">PROJECT MEMORY · #{state.data.project.id}</p>
            <h1>{state.data.project.address}</h1>
            <p className="app-lead">
              Created {fmtTimestamp(state.data.project.created_at)} · status{" "}
              <strong>{state.data.project.status}</strong>
            </p>

            <div className="panel" style={{ marginTop: 34 }}>
              <p className="section-label">UPLOAD EVIDENCE</p>
              <h2>Floor plan or EPC</h2>
              <p className="form-note">Upload a floor plan or EPC (PDF) — the pipeline&apos;s intelligence step will extract space facts when re-run.</p>
              <form className="analyse-form evidence-form" onSubmit={uploadEvidence} style={{ marginTop: 16 }}>
                <input name="evidence" type="file" accept=".pdf,application/pdf" aria-label="Evidence PDF" disabled={uploading} />
                <button type="submit" disabled={uploading}>{uploading ? "Uploading…" : "Upload PDF"}</button>
              </form>
              {uploadedFile && <p className="form-note" aria-live="polite">Uploaded: <strong>{uploadedFile}</strong>. <button type="button" className="text-button" onClick={rerunAnalysis} disabled={rerunning}>{rerunning ? "Re-running…" : "Re-run analysis"}</button></p>}
              {(uploadError || rerunMessage) && <p className="form-note" aria-live="polite" style={uploadError ? { color: "#9b2c2c" } : undefined}>{uploadError || rerunMessage}</p>}
            </div>
            <div className="panel" style={{ marginTop: 22 }}>
              <p className="section-label">FEASIBILITY REPORT</p>
              <p className="form-note" style={{ margin: "0 0 12px" }}>
                The evidence-backed, printable feasibility screening for this
                project (advisory only — not professional advice).
              </p>
              <a
                className="button"
                style={{ textDecoration: "none", display: "inline-block" }}
                href={`/report/${id}`}
              >
                View feasibility report <span>↗</span>
              </a>
            </div>
            <div className="panel" style={{ marginTop: 22 }}>
              <p className="section-label">PIPELINE STEPS</p>
              <ol className="steps">
                {state.data.runs.map((s, i) => (
                  <li key={s.id}>
                    <span className="step-num">0{i + 1}</span>
                    <span className="step-name">{STEP_TITLES[s.step] ?? s.step}</span>
                    <span className="step-meta">
                      {s.finished_at ? fmtTimestamp(s.finished_at) : ""}
                    </span>
                    <Badge status={s.status} />
                  </li>
                ))}
                {state.data.runs.length === 0 && (
                  <li>
                    <span className="empty">No pipeline runs recorded yet.</span>
                  </li>
                )}
              </ol>
              {state.data.runs.some((s) => s.status === "error") && (
                <p className="form-note" style={{ color: "#9b2c2c" }}>
                  {state.data.runs
                    .filter((s) => s.status === "error")
                    .map((s) => `${s.step}: ${s.error}`)
                    .join(" · ")}
                </p>
              )}
            </div>

            <p style={{ margin: "22px 0 0" }}><a className="button" style={{ textDecoration: "none", display: "inline-block" }} href="/analyse">Try another address <span>↗</span></a></p>
            <div className="panel" style={{ marginTop: 22 }}>
              <p className="section-label">EXTRACTED FACTS</p>
              {state.data.facts.length === 0 ? (
                <p className="empty">No facts extracted yet.</p>
              ) : (
                <table className="facts">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Key</th>
                      <th>Value</th>
                      <th>Confidence</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.data.facts.map((f) => (
                      <tr key={f.id}>
                        <td>{f.category}</td>
                        <td className="mono">{f.key}</td>
                        <td>{f.value}</td>
                        <td className="conf">{Math.round(f.confidence * 100)}%</td>
                        <td className="mono">{f.source_name ?? "inferred"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="panel" style={{ marginTop: 22 }}>
              <p className="section-label">SOURCES</p>
              {state.data.sources.length === 0 ? (
                <p className="empty">No sources recorded yet.</p>
              ) : (
                <ul className="sources">
                  {state.data.sources.map((s) => (
                    <li key={s.id}>
                      <span className="src-name">{s.name}</span>
                      {s.url && (
                        <>
                          {" "}
                          · <a href={s.url} className="src-url">{s.url}</a>
                        </>
                      )}
                      <span className="src-url">
                        {" "}
                        · fetched {fmtTimestamp(s.fetched_at)}
                      </span>
                      {s.notes && <p className="form-note" style={{ margin: "4px 0 0" }}>{s.notes}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel" style={{ marginTop: 22 }}>
              <p className="section-label">DECISIONS</p>
              {state.data.decisions.length === 0 ? (
                <p className="empty">
                  No user decisions yet — decision points arrive with the concept
                  step in a later phase. This project can be resumed at any time.
                </p>
              ) : (
                <ul className="decisions">
                  {state.data.decisions.map((d) => (
                    <li key={d.id}>
                      <span className="src-name">{d.choice}</span>
                      <span className="src-url"> · step {d.step} · {fmtTimestamp(d.created_at)}</span>
                      {d.rationale && <p className="form-note" style={{ margin: "4px 0 0" }}>{d.rationale}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
