import { sql } from "~/db";
import { ensureSchema, toJson, rowsToJson } from "~/project-schema";

/**
 * ATLAS AI — analysis pipeline runner (Phase 1).
 *
 * runPipeline(address) creates a `projects` row and executes the ordered step
 * list below. Every step writes its artifacts into project memory:
 *   - a `pipeline_runs` row per step (status: running → done | pending | error)
 *   - any `facts` / `sources` the step extracted
 * so a project's memory is a complete, resumable record of the work done.
 *
 * Pipeline order (later phases drop in behind the stubs):
 *   1. normalise     — REAL: address normalisation & validation (local only)
 *   2. discovery     — STUB: find public sources for the address (next task)
 *   3. collection    — STUB: fetch/organise documents into the project
 *   4. intelligence  — STUB: extract structured facts with confidence scores
 *   5. feasibility   — STUB: financial pro-forma (ROI, cashflow, sensitivity)
 *   6. report        — STUB: render the evidence-backed feasibility report
 */

type Db = ReturnType<typeof sql>;

export interface StepContext {
  db: Db;
  projectId: string;
  address: string;
}

export interface FactOut {
  category: string;
  key: string;
  value: string;
  confidence: number;
  sourceId: string | null;
}

export interface SourceOut {
  name: string;
  url: string | null;
  notes: string | null;
}

export interface StepOutput {
  note?: string;
  facts?: FactOut[];
  sources?: SourceOut[];
}

export interface PipelineStepDef {
  name: string;
  title: string;
  implemented: boolean;
  run: (ctx: StepContext, runId: string) => Promise<{ status: "done" | "pending"; output: StepOutput }>;
}

export interface StepRunResult {
  id: string;
  step: string;
  status: string;
  error: string | null;
  output: StepOutput;
}

/* ------------------------------------------------------------------ */
/* Step implementations                                                */
/* ------------------------------------------------------------------ */

/** REAL step — normalise + validate the submitted address, locally, free. */
const normaliseStep: PipelineStepDef = {
  name: "normalise",
  title: "Address normalisation & validation",
  implemented: true,
  run: async (ctx) => {
    const raw = ctx.address.trim().replace(/\s+/g, " ");
    const upper = raw.toUpperCase();
    // UK postcode, e.g. SW1A 1AA / SE19 3AT / W1U 3BW / M1 1AE. Normalise case
    // and spacing. [A-Z0-9]? (not just [A-Z]?) covers two-digit areas like SE19.
    const postcodeMatch = upper.match(/\b[A-Z]{1,2}\d[A-Z0-9]?\s*\d[A-Z]{2}\b/);
    const postcode = postcodeMatch ? postcodeMatch[0].replace(/\s+/g, " ") : null;
    const normalised = postcode && postcodeMatch ? raw.replace(postcodeMatch[0], postcode) : raw;
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    const valid = wordCount >= 3 && raw.length >= 8;
    // Confidence scoring — the platform never overclaims. A well-formed UK
    // address with a detected postcode is high-confidence; otherwise lower.
    const confidence = postcode ? 0.95 : valid ? 0.7 : 0.4;

    // Record the provenance: the fact came from user input, not an external
    // source (no external fetching in this phase).
    const [source] = await ctx.db`
      INSERT INTO sources (project_id, name, url, notes)
      VALUES (${ctx.projectId}, 'user-provided address', NULL,
        'Address submitted by the user in the /analyse form. Not yet verified against an external address source (discovery step pending).')
      RETURNING id`;
    const sourceId = String(source.id);

    const facts: FactOut[] = [
      { category: "address", key: "raw", value: raw, confidence: 1, sourceId },
      { category: "address", key: "normalised", value: normalised, confidence, sourceId },
    ];
    if (postcode) facts.push({ category: "address", key: "postcode", value: postcode, confidence: 0.99, sourceId });
    facts.push({ category: "address", key: "valid", value: valid ? "yes" : "no", confidence, sourceId });

    for (const f of facts) {
      await ctx.db`
        INSERT INTO facts (project_id, category, key, value, confidence, source_id)
        VALUES (${ctx.projectId}, ${f.category}, ${f.key}, ${f.value}, ${f.confidence}, ${f.sourceId})`;
    }

    return {
      status: "done",
      output: {
        note: "Address normalised and validated locally (no external lookup in this phase).",
        facts,
        sources: [
          {
            name: "user-provided address",
            url: null,
            notes: "Address submitted by the user in the /analyse form.",
          },
        ],
      },
    };
  },
};

/** STUB factory — records a `pending` run and returns a marker output. */
function stub(name: string, title: string, note: string): PipelineStepDef {
  return {
    name,
    title,
    implemented: false,
    run: async (ctx, runId) => {
      // Mark this step pending in project memory: not implemented yet, but the
      // row exists so the loop is complete and later phases are drop-in.
      await ctx.db`
        UPDATE pipeline_runs SET status = 'pending', finished_at = NOW() WHERE id = ${runId}`;
      return { status: "pending", output: { note } };
    },
  };
}

export const PIPELINE_STEPS: PipelineStepDef[] = [
  normaliseStep,
  stub(
    "discovery",
    "Property discovery",
    "Stub: find public sources for this address (local-authority planning portal, EPC register, land registry, flood/heritage/Green Belt layers).",
  ),
  stub(
    "collection",
    "Document collection",
    "Stub: fetch and organise documents into the project (planning, EPC, floorplans, legal, history, metadata).",
  ),
  stub(
    "intelligence",
    "Document intelligence",
    "Stub: extract structured facts from collected documents (use class, dimensions, occupancy, services) with per-fact confidence.",
  ),
  stub(
    "feasibility",
    "Financial feasibility",
    "Stub: build the financial model — purchase, refurbishment, fees, revenue, ROI, cashflow, sensitivity (advisory).",
  ),
  stub(
    "report",
    "Report generation",
    "Stub: render the evidence-backed feasibility report with a professional-review flag list.",
  ),
];

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */

async function runStep(db: Db, projectId: string, step: PipelineStepDef, address: string): Promise<StepRunResult> {
  const [run] = await db`
    INSERT INTO pipeline_runs (project_id, step, status, started_at)
    VALUES (${projectId}, ${step.name}, 'running', NOW())
    RETURNING id`;
  const runId = String(run.id);
  try {
    const { status, output } = await step.run({ db, projectId, address }, runId);
    // The step may have marked itself (stubs set 'pending'); write the final
    // status regardless so the row is always consistent.
    await db`
      UPDATE pipeline_runs SET status = ${status}, finished_at = NOW(), error = NULL WHERE id = ${runId}`;
    return { id: runId, step: step.name, status, error: null, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db`
      UPDATE pipeline_runs SET status = 'error', finished_at = NOW(), error = ${message} WHERE id = ${runId}`;
    return { id: runId, step: step.name, status: "error", error: message, output: { note: message } };
  }
}

/**
 * Create a project row for `address` and run the whole pipeline, writing every
 * step's status into project memory. Returns the project id, its final status
 * and the ordered step statuses — enough for the /analyse page to render.
 */
export async function runPipeline(address: string) {
  const db = sql();
  await ensureSchema();

  const [project] = await db`
    INSERT INTO projects (address, status) VALUES (${address}, 'running')
    RETURNING id, address, status`;
  const projectId = String(project.id);

  let projectStatus = "complete";
  try {
    for (const step of PIPELINE_STEPS) {
      const result = await runStep(db, projectId, step, address);
      if (result.status === "error") projectStatus = "failed";
    }
  } catch (err) {
    // Belt-and-braces: runStep already captures step errors, but if the loop
    // itself breaks (DB outage mid-run), fail the project rather than leave it
    // looking stuck in 'running'.
    projectStatus = "failed";
    await db`UPDATE projects SET status = ${projectStatus}, updated_at = NOW() WHERE id = ${projectId}`;
    throw err;
  }
  await db`UPDATE projects SET status = ${projectStatus}, updated_at = NOW() WHERE id = ${projectId}`;

  const runs = await db`
    SELECT id, step, status, started_at, finished_at, error
    FROM pipeline_runs WHERE project_id = ${projectId} ORDER BY id`;
  const steps = (rowsToJson(runs, ["started_at", "finished_at"]) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    step: String(r.step),
    status: String(r.status),
    started_at: r.started_at,
    finished_at: r.finished_at,
    error: r.error,
  }));

  return { projectId, address, status: projectStatus, steps };
}

/* ------------------------------------------------------------------ */
/* Project memory read (used by /project/[id] and /api/project)        */
/* ------------------------------------------------------------------ */

/**
 * Load the full project memory: project row, pipeline runs, facts (with their
 * source names), sources and decisions. All timestamps coerced to strings so
 * the result is safe to hand to a client component / JSON response.
 */
export async function getProjectMemory(projectId: string) {
  const db = sql();
  await ensureSchema();

  const [project] = await db`
    SELECT id, address, status, created_at, updated_at FROM projects WHERE id = ${projectId}`;
  if (!project) throw new Error("not found");

  const runs = await db`
    SELECT id, step, status, started_at, finished_at, error
    FROM pipeline_runs WHERE project_id = ${projectId} ORDER BY id`;
  const facts = await db`
    SELECT f.id, f.category, f.key, f.value, f.confidence, f.source_id, s.name AS source_name
    FROM facts f LEFT JOIN sources s ON s.id = f.source_id
    WHERE f.project_id = ${projectId} ORDER BY f.id`;
  const sources = await db`
    SELECT id, name, url, fetched_at, notes FROM sources WHERE project_id = ${projectId} ORDER BY id`;
  const decisions = await db`
    SELECT id, step, choice, rationale, created_at FROM decisions WHERE project_id = ${projectId} ORDER BY id`;

  return {
    project: {
      id: String(project.id),
      address: String(project.address),
      status: String(project.status),
      created_at: toJson(project.created_at),
      updated_at: toJson(project.updated_at),
    },
    runs: (rowsToJson(runs, ["started_at", "finished_at"]) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      step: String(r.step),
      status: String(r.status),
      started_at: r.started_at,
      finished_at: r.finished_at,
      error: r.error,
    })),
    facts: (rowsToJson(facts, []) as Record<string, unknown>[]).map((f) => ({
      id: String(f.id),
      category: String(f.category),
      key: String(f.key),
      value: String(f.value),
      confidence: Number(f.confidence),
      source_id: f.source_id === null || f.source_id === undefined ? null : String(f.source_id),
      source_name: f.source_name === null || f.source_name === undefined ? null : String(f.source_name),
    })),
    sources: (rowsToJson(sources, ["fetched_at"]) as Record<string, unknown>[]).map((s) => ({
      id: String(s.id),
      name: String(s.name),
      url: s.url === null || s.url === undefined ? null : String(s.url),
      fetched_at: s.fetched_at,
      notes: s.notes === null || s.notes === undefined ? null : String(s.notes),
    })),
    decisions: (rowsToJson(decisions, ["created_at"]) as Record<string, unknown>[]).map((d) => ({
      id: String(d.id),
      step: String(d.step),
      choice: String(d.choice),
      rationale: d.rationale === null || d.rationale === undefined ? null : String(d.rationale),
      created_at: d.created_at,
    })),
  };
}
