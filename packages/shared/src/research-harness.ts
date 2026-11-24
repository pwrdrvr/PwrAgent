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
  /**
   * Where the run's records came from: the MathOS Platform origin and team, or the bridge program.
   * Recorded at admission; a reconcile through a different source is refused. Absent on older runs.
   */
  sourceKey?: string;
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
  /**
   * Execution's member limit, which the bridge binds before admission. An import takes its members from the
   * source's `started` record instead, up to RESEARCH_MAX_WORKERS, and ignores this.
   */
  workers?: number;
  /** Required for execution, whose bridge binds a deadline before admission. An import has none. */
  minutes?: number;
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
 * What the window may know about the configured source. Never a credential value,
 * the full command line, or anything the window could use to choose an executable.
 */
export type ResearchHarnessStatus = {
  configured: boolean;
  /** Where Harness records come from: PwrAgent's own MathOS Platform client, or an installed bridge. */
  source?: ResearchHarnessSource;
  /** The bridge executable's file name. */
  bridge?: string;
  /** MathOS Platform: the platform's origin and the chosen team's id. */
  platformOrigin?: string;
  platformTeam?: string;
  /** The profile's config.toml cannot be used; new adapter work is refused. */
  configError?: string;
  model?: string;
  endpointOrigin?: string;
  endpointError?: string;
  /** Name of the environment variable that holds the model API key, and whether it is set. */
  credentialEnv?: string;
  credentialSet?: boolean;
  /** Whether a MathOS Platform API key is stored. Presence only, never the value; absent when the store cannot be read. */
  platformKeyStored?: boolean;
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

/**
 * Where a Research run's Harness records come from. `mathos` is PwrAgent's own
 * read-only client for the hosted MathOS Platform; `bridge` launches an installed
 * bridge program configured in `[research.harness]`.
 */
export type ResearchHarnessSource = "mathos" | "bridge";
/** `[research.mathos]`: the team whose VM PwrAgent reads, and the platform's origin. The key is a secret, never here. */
export type ResearchMathosConfig = { team?: string; origin?: string };
export type MathosTeam = { id: string; name: string };
export type MathosTeamsResult = { ok: true; teams: MathosTeam[] } | { ok: false; error: string };
/** A session's running or latest swarm on the team's VM, as its read-only status reports it. */
export type MathosSwarm = {
  project: string;
  session: string;
  swarm: string;
  /** The source's own word: running, interrupted, ended… */
  state: string;
  /** A bounded preview of the swarm's task. */
  task: string;
  members: number;
  running: boolean;
};
/** `truncated`: the VM has more sessions than PwrAgent looked through. */
export type MathosSwarmsResult = { ok: true; swarms: MathosSwarm[]; sessions: number; truncated: boolean } | { ok: false; error: string };
export const MATHOS_PLATFORM_DEFAULT_ORIGIN = "https://os.openmathmodel.org";
/** A MathOS team id, as the platform's own client validates it. */
export const MATHOS_TEAM_ID = /^o-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What the platform's own client accepts as a compute API credential. */
export const MATHOS_API_KEY = /^[\x21-\x7e]{1,512}$/;

/**
 * The source in use. An explicit `harness_source` wins; otherwise a profile that
 * already configured a bridge program keeps it, and every other profile reads
 * the MathOS Platform directly.
 */
export function resolveResearchHarnessSource(research: { source?: ResearchHarnessSource; harness?: ResearchHarnessConfig } | undefined): ResearchHarnessSource {
  return research?.source ?? (research?.harness?.command ? "bridge" : "mathos");
}

/** The platform's plain origin: HTTPS, or HTTP to this machine for tests. Blank is the hosted platform. */
export function normalizeMathosPlatformOrigin(value: string | undefined): { ok: true; origin: string } | { ok: false; error: string } {
  const text = value?.trim();
  if (!text) return { ok: true, origin: MATHOS_PLATFORM_DEFAULT_ORIGIN };
  let url: ParsedUrl;
  try { url = new URL(text); } catch { return { ok: false, error: "Enter the platform’s address, for example https://os.openmathmodel.org." }; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
    return { ok: false, error: "Use HTTPS, or HTTP to this machine." };
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return { ok: false, error: "Enter only the platform’s address, without a path." };
  }
  return { ok: true, origin: url.origin };
}

export const RESEARCH_HARNESS_MAX_ARGS = 64;
const MAX_ARGS_JSON = 16_000;
const MAX_COMMAND = 4_096;
const MAX_MODEL = 200;
const MAX_ENDPOINT = 2_048;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Control characters the config writer cannot escape. Tab, newline and carriage
// return round-trip, so a hand-written value holding one stays saveable.
// eslint-disable-next-line no-control-regex -- the point is to find them.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
// This package compiles without DOM or Node types. Every runtime it ships to
// (Electron main, renderer, Node tests) has the WHATWG URL global.
type ParsedUrl = { protocol: string; hostname: string; username: string; password: string; search: string; hash: string; pathname: string; origin: string };
declare const URL: new (input: string) => ParsedUrl;

/** POSIX `/…`, Windows `C:\…` or `C:/…`, or a UNC `\\host\share` path. */
export function isAbsoluteExecutablePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * Validates and normalizes `[research.harness]` before it is written. The
 * desktop config writer applies this, and Settings uses it for inline errors,
 * so a saved table is always one the reader accepts. Blank optional values are
 * absent, and the endpoint follows the same rules execution enforces.
 */
export function normalizeResearchHarnessConfig(input: {
  command: string;
  args: readonly string[];
  endpoint?: string;
  model?: string;
  apiKeyEnv?: string;
}): { ok: true; value: ResearchHarnessConfig } | { ok: false; field: "command" | "args" | "endpoint" | "model" | "apiKeyEnv"; error: string } {
  const command = input.command.trim();
  if (!command) return { ok: false, field: "command", error: "Choose the bridge program." };
  if (!isAbsoluteExecutablePath(command)) return { ok: false, field: "command", error: "Use the program’s full path." };
  if (command.length > MAX_COMMAND) return { ok: false, field: "command", error: "That path is too long." };
  if (CONTROL.test(command)) return { ok: false, field: "command", error: "The path contains a control character." };
  if (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== "string")) {
    return { ok: false, field: "args", error: "Arguments must be text." };
  }
  if (input.args.length > RESEARCH_HARNESS_MAX_ARGS) {
    return { ok: false, field: "args", error: `Use at most ${RESEARCH_HARNESS_MAX_ARGS} arguments.` };
  }
  if (JSON.stringify(input.args).length > MAX_ARGS_JSON) return { ok: false, field: "args", error: "The arguments are too long." };
  if (input.args.some((arg) => CONTROL.test(arg))) return { ok: false, field: "args", error: "An argument contains a control character." };
  const value: ResearchHarnessConfig = { command, args: [...input.args] };
  const endpoint = input.endpoint?.trim();
  if (endpoint) {
    let url: ParsedUrl;
    try { url = new URL(endpoint); } catch { return { ok: false, field: "endpoint", error: "Enter a full URL." }; }
    if (endpoint.length > MAX_ENDPOINT) return { ok: false, field: "endpoint", error: "That URL is too long." };
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))) {
      return { ok: false, field: "endpoint", error: "Use HTTPS, or HTTP to this machine." };
    }
    if (url.username || url.password || url.search || url.hash) {
      return { ok: false, field: "endpoint", error: "Do not put credentials or a query in the URL." };
    }
    value.endpoint = endpoint;
  }
  const model = input.model?.trim();
  if (model) {
    if (model.length > MAX_MODEL) return { ok: false, field: "model", error: "That model name is too long." };
    if (CONTROL.test(model)) return { ok: false, field: "model", error: "The model name contains a control character." };
    value.model = model;
  }
  const apiKeyEnv = input.apiKeyEnv?.trim();
  if (apiKeyEnv) {
    if (!ENV_NAME.test(apiKeyEnv)) return { ok: false, field: "apiKeyEnv", error: "Use a variable name: letters, digits and underscores." };
    value.apiKeyEnv = apiKeyEnv;
  }
  return { ok: true, value };
}

/** Settings edits arguments one per line. Blank lines are not arguments. */
export function researchHarnessArgsFromLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
