import type { AppServerBackendKind, ForgeKind } from "@pwragent/shared";

export const FORGE_READ_OPERATIONS = ["get_forge_status", "list_ci_runs", "get_ci_run", "get_ci_job", "read_ci_job_log", "get_commit_checks", "list_ci_artifacts", "download_ci_artifact"] as const;
export type ForgeReadOperation = typeof FORGE_READ_OPERATIONS[number];
export type ForgeRepository = { provider: ForgeKind; host: string; owner: string; repo: string };
export type ForgeReadArgs = {
  backend?: AppServerBackendKind;
  threadId?: string;
  instanceId?: string;
  repository?: ForgeRepository;
  url?: string;
  branch?: string;
  headSha?: string;
  refresh?: boolean;
  page?: number;
  perPage?: number;
  runId?: number;
  artifactId?: number;
  jobId?: number;
  maxChars?: number;
  beforeChar?: number;
  logSnapshot?: string;
};
export type ForgeReadRequest = {
  operation: ForgeReadOperation;
  args: ForgeReadArgs;
  backend: AppServerBackendKind;
  threadId: string;
};
export class ForgeReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function validateForgeReadArgs(operation: string, value: unknown): asserts value is ForgeReadArgs {
  if (!FORGE_READ_OPERATIONS.includes(operation as ForgeReadOperation) || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new ForgeReadError("invalid_arguments", "Provide a known forge read operation and an argument object.");
  }
  const args = value as Record<string, unknown>;
  const common = ["backend", "threadId", "instanceId", "repository"];
  const fields: Record<ForgeReadOperation, string[]> = {
    get_forge_status: ["url", "branch", "refresh"], list_ci_runs: ["branch", "headSha", "page", "perPage"],
    get_ci_run: ["runId", "page", "perPage"], get_ci_job: ["jobId"], read_ci_job_log: ["jobId", "maxChars", "beforeChar", "logSnapshot"],
    get_commit_checks: ["headSha", "branch", "page", "perPage"], list_ci_artifacts: ["runId", "page", "perPage"],
    download_ci_artifact: ["runId", "artifactId"],
  };
  if (Object.keys(args).some((key) => ![...common, ...fields[operation as ForgeReadOperation]].includes(key))) {
    throw new ForgeReadError("invalid_arguments", "Unknown argument for this forge tool.");
  }
  for (const key of ["backend", "threadId", "instanceId", "url", "branch", "headSha"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key].trim() || (args[key] as string).length > 2000)) {
      throw new ForgeReadError("invalid_arguments", `${key} must be a nonempty bounded string.`);
    }
  }
  for (const [key, max] of [["page", 1000], ["perPage", 100], ["runId", Number.MAX_SAFE_INTEGER], ["artifactId", Number.MAX_SAFE_INTEGER], ["jobId", Number.MAX_SAFE_INTEGER], ["maxChars", 50000], ["beforeChar", Number.MAX_SAFE_INTEGER]] as const) {
    if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) < 1 || Number(args[key]) > max)) {
      throw new ForgeReadError("invalid_arguments", `${key} must be an integer from 1 to ${max}.`);
    }
  }
  if ((["get_ci_run", "list_ci_artifacts"].includes(operation) && !args.runId) || (["get_ci_job", "read_ci_job_log"].includes(operation) && !args.jobId)) {
    throw new ForgeReadError("invalid_arguments", "This operation requires its runId or jobId.");
  }
  if (operation === "download_ci_artifact" && (!args.runId || !args.artifactId)) {
    throw new ForgeReadError("invalid_arguments", "Downloading an artifact requires both runId and artifactId from list_ci_artifacts.");
  }
  if (operation === "get_commit_checks" && (typeof args.headSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(args.headSha))) {
    throw new ForgeReadError("invalid_arguments", "headSha must be a full commit SHA from PR/MR status or a CI run.");
  }
  if ((args.beforeChar !== undefined) !== (args.logSnapshot !== undefined)
    || (args.logSnapshot !== undefined && (typeof args.logSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(args.logSnapshot)))) {
    throw new ForgeReadError("invalid_arguments", "Pass both beforeChar and logSnapshot from the previous log page.");
  }
  if (args.refresh !== undefined && typeof args.refresh !== "boolean") throw new ForgeReadError("invalid_arguments", "refresh must be boolean.");
  if (args.repository !== undefined) {
    const r = args.repository as ForgeRepository;
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => !["provider", "host", "owner", "repo"].includes(k))
      || !["github", "gitlab"].includes(r.provider) || typeof r.host !== "string" || r.host.length > 253 || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?$/i.test(r.host)
      || typeof r.owner !== "string" || r.owner.length > 2000 || !r.owner.split("/").every(validSegment) || (r.provider === "github" && r.owner.includes("/"))
      || !validSegment(r.repo)) throw new ForgeReadError("invalid_arguments", "repository requires provider, host, owner and repo; use the actual host and GitLab namespace.");
  }
}
function validSegment(value: unknown): boolean {
  return typeof value === "string" && value.length <= 255 && /^[a-z0-9_.-]+$/i.test(value) && value !== "." && value !== "..";
}
export function repositoryKey(r: ForgeRepository): string {
  const path = `${r.owner}/${r.repo}`;
  return `${r.provider}:${r.host.toLowerCase()}/${r.provider === "github" ? path.toLowerCase() : path}`;
}
export function repositoryUrl(r: ForgeRepository): string {
  return `https://${r.host}/${r.owner.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(r.repo)}`;
}
