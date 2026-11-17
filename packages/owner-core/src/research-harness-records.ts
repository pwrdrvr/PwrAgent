import { createHash } from "node:crypto";
import type { ResearchEvent, ResearchEventData, ResearchRun, ResearchProvenance, ResearchHarnessState } from "@pwragent/shared";
import { RESEARCH_HARNESS_REVISION } from "@pwragent/shared";

type Normalized = { data: ResearchEventData; provenance: ResearchProvenance };
export function harnessRecordDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, canonical(x)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Reads the public swarm record contract at the pinned revision. No source verdict is a local review. */
export function normalizeHarnessRecords(run: Pick<ResearchRun, "harness" | "workerLimit" | "approaches"> & { events?: ResearchEvent[] }, records: unknown[], readRecord?: (seq: number) => ResearchEvent | undefined): { events: Normalized[]; state: ResearchHarnessState; ended: boolean } {
  if (!run.harness) throw new Error("Not a Harness run");
  if (!Array.isArray(records) || records.length > 50 || JSON.stringify(records).length > 256_000) throw new Error("Harness page exceeds its bound");
  const state = structuredClone(run.harness);
  const events: Normalized[] = [];
  let ended = state.state === "ended";
  for (const input of records) {
    const r = object(input);
    if (JSON.stringify(r).length > 16_000) throw new Error("Harness record exceeds its bound");
    const seq = integer(r.seq), at = integer(r.at_ms, true);
    if (r.swarm !== state.swarm) throw new Error("Harness record belongs to another swarm");
    const digest = harnessRecordDigest(r);
    if (seq <= state.cursor) {
      const previous = events.find((e) => e.provenance?.seq === seq) ?? (readRecord ? readRecord(seq) : run.events?.find((e) => e.provenance?.seq === seq));
      if (previous?.provenance?.digest !== digest) throw new Error("Conflicting Harness redelivery");
      continue;
    }
    if (seq !== state.cursor + 1) throw new Error("Incomplete Harness records; reconcile the source cursor");
    const kind = text(r.event, 80);
    if (ended && kind !== "resumed" && ["started", "member", "direction", "finding", "submission", "usage", "ended"].includes(kind)) throw new Error("Harness records changed after ending without a resume record");
    if (seq === 1 && kind !== "started") throw new Error("Missing Harness started record");
    const provenance: ResearchProvenance = { adapter: "open-math-harness", version: 1, upstreamRevision: RESEARCH_HARNESS_REVISION,
      project: state.project, session: state.session, swarm: state.swarm, seq, at, digest,
      ...(typeof r.member === "string" ? { member: text(r.member, 64) } : {}),
      ...(typeof r.direction === "string" ? { direction: text(r.direction, 64) } : {}) };
    const add = (data: ResearchEventData) => events.push({ data, provenance });
    // Every source record has an immutable receipt, including unfamiliar variants.
    add({ type: "harness_observation", event: kind, text: JSON.stringify(r) });
    if (kind === "started") {
      if (seq !== 1 || r.project !== state.project || r.session !== state.session) throw new Error("Harness origin does not match the requested project/session");
      if (!Array.isArray(r.members) || !r.members.length || r.members.length > run.workerLimit) throw new Error("Harness member count exceeds the operator's limit");
      state.members = r.members.map((m) => text(m, 64));
      if (new Set(state.members).size !== state.members.length) throw new Error("Duplicate Harness member");
      for (let i = state.members.length; i < run.workerLimit; i++) add({ type: "worker", approachId: `a${i + 1}`, state: "stopped" });
    } else if (kind === "usage") state.calls = integer(r.calls, true);
    else if (kind === "ended") {
      state.calls = integer(r.calls, true);
      state.state = "ended";
      ended = true;
      // A terminal service receipt settles execution only, never a PwrAgent review.
      for (const approach of run.approaches) add({ type: "worker", approachId: approach.id, state: "ended", note: `Source outcome: ${text(r.outcome, 80)}` });
    } else if (kind === "resumed") {
      if (!Array.isArray(r.members) || r.members.some((m) => typeof m !== "string" || !state.members.includes(m))) throw new Error("Unknown resumed Harness member");
      state.calls = integer(r.calls, true);
      state.state = state.mode === "import" ? "running" : "unknown";
      state.note = "Source work resumed. Observation does not authorize replay of PwrAgent execution.";
      ended = false;
    }
    else if (["member", "direction", "finding", "submission", "verdict", "refused"].includes(kind)) {
      const member = text(r.member, 64);
      const index = state.members.indexOf(member);
      if (index < 0) throw new Error("Unknown Harness member");
      const approachId = `a${index + 1}`;
      if (kind === "member") {
        if (!["running", "submitted", "ended", "stopped"].includes(String(r.state))) throw new Error("Unknown Harness member state");
        add({ type: "worker", approachId, state: r.state === "submitted" ? "ended" : r.state as "running" | "ended" | "stopped" });
      } else if (kind === "direction") {
        const direction = text(r.text, 4000);
        if (!["active", "abandoned", "dead", "succeeded"].includes(String(r.state))) throw new Error("Unknown Harness direction state");
        add({ type: "direction", approachId, title: direction.slice(0, 160), task: direction, reason: `Harness member ${member}; direction ${text(r.direction, 64)}` });
        if (["abandoned", "dead"].includes(String(r.state))) add({ type: "abandoned", approachId, reason: typeof r.reason === "string" && r.reason ? text(r.reason, 4000) : String(r.state) });
      } else if (kind === "finding") {
        if (!["lemma", "partial", "counterexample", "dead_end", "file", "note"].includes(String(r.label))) throw new Error("Unknown Harness finding kind");
        add({ type: "finding", finding: { id: `h:${seq}`, approachId, kind: r.label as "note", text: text(r.text, 4000), paths: paths(r.paths) } });
      } else if (kind === "submission") add({ type: "submission", submission: { id: `h:${seq}`, approachId, text: text(r.report, 4000), paths: paths(r.paths) } });
      // Verdicts/refusals remain source observations; they cannot overwrite local review records.
    }
    state.cursor = seq;
  }
  return { events, state, ended };
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Harness object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error("Invalid Harness text");
  return value;
}
function integer(value: unknown, zero = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error("Invalid Harness sequence/count");
  return value;
}
function paths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 4) throw new Error("Invalid Harness paths");
  return value.map((v) => {
    const p = text(v, 300);
    if (p.includes("\\") || p.includes(":") || p.split("/").some((s) => !s || s === "." || s === "..")) throw new Error("Evidence must be relative to the originating workspace");
    return p;
  });
}
