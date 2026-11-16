import type { ResearchDiscoverySnapshot, ResearchEventData, ResearchProvenance, ResearchRun } from "@pwragent/shared";
import { harnessRecordDigest, object, text } from "./research-harness-records";

/** A bounded service snapshot. Source verification stays an observation, never a local verdict. */
export function normalizeHarnessDiscovery(run: ResearchRun, input: { status: unknown; problems: unknown; tree?: unknown }, observedAt: number): {
  snapshot: ResearchDiscoverySnapshot;
  events: Array<{ data: ResearchEventData; provenance: ResearchProvenance }>;
} {
  const origin = run.harness;
  if (!origin || origin.source !== "discovery") throw new Error("Not a discovery observation");
  if (JSON.stringify(input).length > 256_000) throw new Error("Discovery snapshot exceeds its bound");
  const status = object(input.status), problems = object(input.problems);
  if (status.run !== origin.swarm || problems.run !== origin.swarm) throw new Error("Discovery origin mismatch");
  if (!Array.isArray(problems.problems) || problems.problems.length > 1_000) throw new Error("Discovery problem bound exceeded");
  const seenProblems = new Set<string>();
  const rows = problems.problems.map((input) => {
    const row = object(input), id = text(row.problem, 64);
    if (seenProblems.has(id)) throw new Error("Duplicate discovery problem");
    seenProblems.add(id);
    return { id, state: state(row.state, ["queued", "active", "done"]), nodes: integer(row.nodes), rounds: integer(row.rounds),
      solved: boolean(row.solved), ...(row.stop == null ? {} : { stop: text(row.stop, 4_000) }) };
  });
  const snapshot: ResearchDiscoverySnapshot = { observedAt, state: state(status.state, ["queued", "running", "done", "stopped", "failed"]),
    finished: integer(status.finished), solved: integer(status.solved), tokensIn: integer(status.tokens_in), tokensOut: integer(status.tokens_out),
    ...(status.usd === undefined ? {} : { usd: nonnegative(status.usd) }), problems: rows };
  if (integer(status.problems) !== rows.length || snapshot.finished > rows.length || snapshot.solved > snapshot.finished) throw new Error("Inconsistent discovery counts");
  if (input.tree !== undefined) {
    const tree = object(input.tree);
    if (!origin.problem || tree.run !== origin.swarm || tree.problem !== origin.problem || !seenProblems.has(origin.problem)) throw new Error("Discovery tree origin mismatch");
    if (!Array.isArray(tree.nodes) || tree.nodes.length > 2_000 || !Array.isArray(tree.rounds)) throw new Error("Discovery tree exceeds its bound");
    const seen = new Map<number, number>();
    const nodes = tree.nodes.map((input) => {
      const node = object(input), id = integer(node.id), round = integer(node.round);
      if (seen.has(id) || (seen.size === 0 ? id !== 0 || node.parent !== null || round !== 0 : node.parent === null || !seen.has(integer(node.parent)) || seen.get(integer(node.parent))! >= round)) throw new Error("Invalid discovery ancestry");
      seen.set(id, round);
      if (typeof node.excerpt !== "string" || [...node.excerpt].length > 200) throw new Error("Invalid discovery excerpt");
      if (node.verified !== null && typeof node.verified !== "boolean") throw new Error("Invalid source verification observation");
      return { id, parent: node.parent as number | null, round, score: finite(node.score), sourceVerified: node.verified as boolean | null,
        excerpt: node.excerpt, elapsedMs: integer(node.ms_since_start) };
    });
    // Truncation describes a service prefix, not a missing page to guess or replay.
    snapshot.tree = { problem: origin.problem, state: state(tree.state, ["queued", "active", "done"]), truncated: boolean(tree.truncated), nodes };
  }
  const events = Object.entries(input).filter(([, value]) => value !== undefined).map(([kind, value], i) => ({
    data: { type: "harness_observation" as const, event: `discovery.${kind}`, text: JSON.stringify(value) },
    provenance: { adapter: "open-math-harness" as const, version: 1 as const, upstreamRevision: origin.upstreamRevision,
      project: origin.project, session: origin.session, swarm: origin.swarm, source: "discovery" as const, sequenceKind: "observation" as const,
      ...(kind === "tree" ? { problem: origin.problem } : {}), seq: i + 1, at: observedAt, digest: harnessRecordDigest(value) },
  }));
  return { snapshot, events };
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid discovery number");
  return value;
}
function nonnegative(value: unknown): number { const n = finite(value); if (n < 0) throw new Error("Invalid discovery count"); return n; }
function integer(value: unknown): number { const n = nonnegative(value); if (!Number.isSafeInteger(n)) throw new Error("Invalid discovery count"); return n; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("Invalid discovery flag"); return value; }
function state(value: unknown, allowed: string[]): string { if (typeof value !== "string" || !allowed.includes(value)) throw new Error("Unknown discovery state"); return value; }
