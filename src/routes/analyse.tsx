import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

/**
 * /analyse — enter an address, start the analysis pipeline, and see the
 * project's step statuses with a link to the full project memory view.
 */
export const Route = createFileRoute("/analyse")({ component: Analyse });

interface StepRow {
  id: string;
  step: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

interface Result {
  ok: true;
  projectId: string;
  address: string;
  status: string;
  steps: StepRow[];
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

function Analyse() {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState("");
  const [targetUse, setTargetUse] = useState("barber shop");
  const [designBusy, setDesignBusy] = useState(false);
  const [designMsg, setDesignMsg] = useState("");
  const [confirmGate, setConfirmGate] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!address.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const r = await fetch("/api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error ?? "Analysis failed — please try again.");
        return;
      }
      setResult(data as Result);
      setDesignMsg("");
    } catch {
      setError("Analysis failed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function generateDesign(e: React.FormEvent) {
    e.preventDefault();
    if (!result || designBusy) return;
    setDesignBusy(true);
    setDesignMsg("");
    setConfirmGate(false);
    try {
      const r = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: result.projectId, targetUse }),
      });
      const data = await r.json();
      if (!r.ok) {
        const gated = data.error === "Property not confirmed yet";
        setConfirmGate(gated);
        setDesignMsg(gated ? "" : data.error ?? "Design generation failed — please try again.");
        return;
      }
      setDesignMsg(
        `Concept generated for "${data.programLabel}" — ${data.rooms} room(s), ${data.allocatedM2} m² allocated, ${data.circulationPct}% circulation.`,
      );
    } catch {
      setDesignMsg("Design generation failed — please try again.");
    } finally {
      setDesignBusy(false);
    }
  }

  return (
    <div className="app-page">
      <header className="app-nav">
        <div className="container nav-inner">
          <a href="/" className="logo">
            <img src="/brand/atlas-logo.svg" alt="ATLAS AI" />
          </a>
          <a className="nav-link" href="/">
            Back to site <span>↗</span>
          </a>
        </div>
      </header>

      <main className="app-body container">
        <p className="section-label">ATLAS AI · PLATFORM · PHASE 1</p>
        <h1>Analyse a property address.</h1>
        <p className="app-lead">
          One address starts a project. The pipeline runs its steps and writes everything
          — step statuses, sources and extracted facts — into the project&apos;s shared
          memory, where it can be resumed at any time.
        </p>

        <div className="panel" style={{ marginTop: 34 }}>
          <p className="section-label">START A PROJECT</p>
          <form className="analyse-form" onSubmit={submit} aria-label="Analyse a property address">
            <input
              aria-label="Property address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 8-10 Crown Hill, London SE19 3AT"
              disabled={busy}
            />
            <button type="submit" disabled={busy}>
              {busy ? "Running pipeline…" : "Run analysis"}
            </button>
          </form>
          <p className="form-note" aria-live="polite">
            {error
              ? error
              : "Address is validated locally only — no external data is fetched in this phase."}
          </p>
        </div>

        {result && (
          <div className="panel" style={{ marginTop: 22 }}>
            <p className="section-label">PROJECT STARTED</p>
            <h2 style={{ margin: "0 0 4px" }}>{result.address}</h2>
            <p className="form-note">
              Project #{result.projectId} · status <strong>{result.status}</strong> ·{" "}
              <a href={`/project/${result.projectId}`}>Open full project memory ↗</a>
            </p>
            <ol className="steps">
              {result.steps.map((s, i) => (
                <li key={s.id}>
                  <span className="step-num">0{i + 1}</span>
                  <span className="step-name">{STEP_TITLES[s.step] ?? s.step}</span>
                  <Badge status={s.status} />
                </li>
              ))}
            </ol>
            <p className="form-note">
              Steps marked <strong>pending</strong> are stubs awaiting later phases — the loop
              itself is complete and provably working end-to-end.
            </p>

            <div style={{ borderTop: "1px solid var(--line, #ddd6c8)", marginTop: 20, paddingTop: 18 }}>
              <p className="section-label">CONCEPT DESIGN · CONVERT TO A NEW USE</p>
              <form className="analyse-form" onSubmit={generateDesign} aria-label="Generate a concept design">
                <input
                  aria-label="Target use"
                  value={targetUse}
                  onChange={(e) => setTargetUse(e.target.value)}
                  placeholder="e.g. barber shop, cafe, office"
                  disabled={designBusy}
                />
                <button type="submit" disabled={designBusy}>
                  {designBusy ? "Generating concept…" : "Generate concept design"}
                </button>
              </form>
              <p className="form-note" aria-live="polite">
                {confirmGate ? (
                  <>
                    This property hasn't been confirmed yet — the concept design only runs after you confirm the correct
                    property.{" "}
                    <a href={`/confirm/${result.projectId}`}>Confirm this is the right property ↗</a>
                  </>
                ) : designMsg ? (
                  designMsg
                ) : (
                  "The concept is an indicative zoning sketch generated from the space facts in project memory."
                )}
                {!confirmGate && designMsg.startsWith("Concept") && (
                  <>
                    {" "}
                    <a href={`/report/${result.projectId}`}>Open the report to view the floor plan ↗</a>
                  </>
                )}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
