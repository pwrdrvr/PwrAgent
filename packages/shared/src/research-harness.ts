import type { ResearchThread } from "./research";

export const RESEARCH_HARNESS_VERSION = 1;
export const RESEARCH_HARNESS_REVISION = "687f2a20dc6ff552d3c881e10910b46c13e84e2a";
/** Harness states an explicit read-only reconcile may resolve. The owner and the window share this rule. */
export const RESEARCH_HARNESS_RECONCILABLE: readonly ResearchHarnessState["state"][] = ["unknown", "stopping", "imported", "reconciling"];

/** Source identities are observations, never PwrAgent principals or review authority. */
export type ResearchProvenance = {
  adapter: "open-math-harness";
  version: 1;
  upstreamRevision: string;
  project: string;
  session: string;
  swarm: string;
  seq: number;
  at: number;
  member?: string;
  direction?: string;
  digest: string;
  source?: "swarm" | "discovery";
  /** Discovery APIs return snapshots, not a source event sequence or timestamp. */
  sequenceKind?: "observation";
  problem?: string;
};
export type ResearchDiscoverySnapshot = {
  observedAt: number;
  state: string;
  finished: number;
  solved: number;
  tokensIn: number;
  tokensOut: number;
  usd?: number;
  problems: Array<{ id: string; state: string; nodes: number; rounds: number; solved: boolean; stop?: string }>;
  tree?: {
    problem: string;
    state: string;
    truncated: boolean;
    nodes: Array<{ id: number; parent: number | null; round: number; score: number; sourceVerified: boolean | null; excerpt: string; elapsedMs: number }>;
  };
};
export type ResearchHarnessState = {
  version: 1;
  mode: "execute" | "import";
  project: string;
  session: string;
  swarm: string;
  /** Captured by the owner, never supplied by a model or imported record. */
  workspace: string;
  upstreamRevision: string;
  state: "pending" | "running" | "imported" | "unknown" | "stopping" | "stopped" | "ended" | "reconciling";
  cursor: number;
  /** When the owner last committed a source observation (page, snapshot or reconcile result). */
  observedAt?: number;
  /** A cancellation was requested and never acknowledged. It survives the owner rewriting the run's status on restart. */
  unresolved?: "cancel";
  members: string[];
  cancelSupported: boolean;
  model?: string;
  endpointOrigin?: string;
  calls?: number;
  note: string;
  source?: "swarm" | "discovery";
  problem?: string;
  discovery?: ResearchDiscoverySnapshot;
};
export type ResearchHarnessRequest = ResearchThread & {
  requestId: string;
  mode: "execute" | "import";
  project: string;
  session: string;
  swarm: string;
  objective: string;
  workers: number;
  minutes: number;
  /** Required for execution, which spends model budget. Imports make no model call. */
  budgetAcknowledged: boolean;
  source?: "swarm" | "discovery";
  problem?: string;
};
/** A read-only observation into an existing run from its stored cursor. Never sends execute or cancel. */
export type ResearchHarnessReconcileRequest = ResearchThread & { runId: string };
export type ResearchHarnessCapabilities = {
  version: 1;
  upstreamRevision: string;
  execute: boolean;
  import: boolean;
  cancel: boolean;
  discovery?: boolean;
};
/**
 * What the window may know about the configured bridge. Never a credential value,
 * the full command line, or anything the window could use to choose an executable.
 */
export type ResearchHarnessStatus = {
  configured: boolean;
  /** The bridge executable's file name. */
  bridge?: string;
  /** The profile's config.toml cannot be used; new adapter work is refused. */
  configError?: string;
  model?: string;
  endpointOrigin?: string;
  endpointError?: string;
  /** Name of the environment variable that holds the model API key, and whether it is set. */
  credentialEnv?: string;
  credentialSet?: boolean;
  /** The canonical workspace the owner would bind for this thread, when it has one. */
  workspace?: string;
};
/** The bridge's own answer to `hello`, from an explicit operator check. */
export type ResearchHarnessCheck =
  | { ok: true; checkedAt: number; capabilities: { import: boolean; execute: boolean; cancel: boolean; discovery: boolean; researchFunctions: boolean } }
  | { ok: false; checkedAt: number; error: string };
export type ResearchHarnessConfig = {
  command: string;
  args: string[];
  /** Optional OpenAI-compatible Chat Completions endpoint; never discovered implicitly. */
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
};
