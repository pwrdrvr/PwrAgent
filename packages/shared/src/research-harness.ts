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
  calls?: number;
  note: string;
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
};
export type ResearchHarnessCapabilities = {
  version: 1;
  upstreamRevision: string;
  execute: boolean;
  import: boolean;
  cancel: boolean;
};
export type ResearchHarnessConfig = {
  command: string;
  args: string[];
  /** Optional OpenAI-compatible Chat Completions endpoint; never discovered implicitly. */
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
};
