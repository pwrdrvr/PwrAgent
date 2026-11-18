import type { ResearchThread } from "./research";

export const RESEARCH_HARNESS_VERSION = 1;
export const RESEARCH_HARNESS_REVISION = "687f2a20dc6ff552d3c881e10910b46c13e84e2a";

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
  state: "pending" | "running" | "imported" | "unknown" | "stopping" | "stopped" | "ended";
  cursor: number;
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
  budgetAcknowledged: boolean;
  source?: "swarm" | "discovery";
  problem?: string;
};
export type ResearchHarnessCapabilities = {
  version: 1;
  upstreamRevision: string;
  execute: boolean;
  import: boolean;
  cancel: boolean;
  discovery?: boolean;
};
export type ResearchHarnessStatus = { configured: boolean; model?: string; endpointOrigin?: string };
export type ResearchHarnessConfig = {
  command: string;
  args: string[];
  /** Optional OpenAI-compatible Chat Completions endpoint; never discovered implicitly. */
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
};
