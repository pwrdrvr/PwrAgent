import { FORGE_AGENT_WRITE_TOOL_GROUPS, type ForgeAgentToolGroup, type ForgeAgentWriteToolName } from "@pwragent/shared";
import { ForgeReadError, type ForgeRepository } from "./forge-tool-contract";

/**
 * Pull request (GitLab merge request), issue and CI write tools for GitHub and GitLab.
 * Each acts in the calling thread's own repository (the `repository` argument
 * only chooses among its linked remotes), so no tool here accepts a thread or
 * Federation target. Names say "pull request" for both providers.
 */
export const FORGE_PR_READ_OPERATIONS = [
  "get_pull_request",
  "list_pull_requests",
  "list_pull_request_files",
  "get_pull_request_diff",
  "list_pull_request_reviews",
  "list_pull_request_review_threads",
  "get_issue",
  "list_issue_comments",
  "search_issues",
] as const;
export const FORGE_PR_WRITE_OPERATIONS = Object.keys(FORGE_AGENT_WRITE_TOOL_GROUPS) as ForgeAgentWriteToolName[];
export const FORGE_PR_TOOL_OPERATIONS = [...FORGE_PR_READ_OPERATIONS, ...FORGE_PR_WRITE_OPERATIONS] as const;
export type ForgePrReadOperation = typeof FORGE_PR_READ_OPERATIONS[number];
export type ForgePrToolOperation = ForgePrReadOperation | ForgeAgentWriteToolName;

export type ForgeAttachment = { path: string; alt?: string };
export type ForgeReviewComment = { path: string; line: number; side?: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; body: string };
export type ForgePrToolArgs = {
  repository?: ForgeRepository;
  runId?: number;
  number?: number;
  url?: string;
  branch?: string;
  state?: "open" | "closed" | "all";
  head?: string;
  base?: string;
  page?: number;
  perPage?: number;
  after?: string;
  unresolvedOnly?: boolean;
  includePatch?: boolean;
  path?: string;
  maxChars?: number;
  startChar?: number;
  diffSnapshot?: string;
  query?: string;
  kind?: "pr" | "issue";
  title?: string;
  body?: string;
  draft?: boolean;
  attachments?: ForgeAttachment[];
  addLabels?: string[];
  removeLabels?: string[];
  reviewers?: string[];
  stateReason?: "completed" | "not_planned" | "reopened";
  commentId?: number;
  reviewThreadId?: string;
  resolved?: boolean;
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  comments?: ForgeReviewComment[];
  commitId?: string;
  method?: "merge" | "squash" | "rebase";
  expectedHeadSha?: string;
  commitTitle?: string;
  commitMessage?: string;
};

export const FORGE_BODY_MAX_CHARS = 65_000;
export const FORGE_ATTACHMENTS_MAX = 10;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const LABEL_MAX = 50;

const FIELDS: Record<ForgePrToolOperation, string[]> = {
  get_pull_request: ["number", "url", "branch"],
  list_pull_requests: ["state", "head", "base", "page", "perPage"],
  list_pull_request_files: ["number", "includePatch", "page", "perPage"],
  get_pull_request_diff: ["number", "path", "maxChars", "startChar", "diffSnapshot"],
  list_pull_request_reviews: ["number", "page", "perPage"],
  list_pull_request_review_threads: ["number", "unresolvedOnly", "perPage", "after"],
  get_issue: ["number"],
  list_issue_comments: ["number", "kind", "page", "perPage"],
  search_issues: ["query", "kind", "state", "page", "perPage"],
  create_pull_request: ["title", "body", "head", "base", "draft", "attachments", "addLabels", "reviewers"],
  update_pull_request: ["number", "title", "body", "base", "state", "draft", "attachments", "addLabels", "removeLabels", "reviewers"],
  add_issue_comment: ["number", "kind", "body", "attachments"],
  reply_to_review_comment: ["number", "commentId", "reviewThreadId", "body"],
  submit_pull_request_review: ["number", "event", "body", "comments", "commitId"],
  resolve_review_thread: ["reviewThreadId", "resolved", "number"],
  create_issue: ["title", "body", "attachments", "addLabels"],
  update_issue: ["number", "title", "body", "state", "stateReason", "attachments", "addLabels", "removeLabels"],
  merge_pull_request: ["number", "method", "expectedHeadSha", "commitTitle", "commitMessage"],
  rerun_failed_ci_jobs: ["runId"],
};
const REQUIRED: Partial<Record<ForgePrToolOperation, string[]>> = {
  list_pull_request_files: ["number"],
  get_pull_request_diff: ["number"],
  list_pull_request_reviews: ["number"],
  list_pull_request_review_threads: ["number"],
  get_issue: ["number"],
  list_issue_comments: ["number"],
  search_issues: ["query"],
  create_pull_request: ["title", "head"],
  update_pull_request: ["number"],
  add_issue_comment: ["number", "body"],
  reply_to_review_comment: ["number", "body"],
  submit_pull_request_review: ["number", "event"],
  resolve_review_thread: ["reviewThreadId", "resolved"],
  create_issue: ["title"],
  update_issue: ["number"],
  merge_pull_request: ["number", "expectedHeadSha"],
  rerun_failed_ci_jobs: ["runId"],
};

export function forgePrToolRequiredFields(operation: ForgePrToolOperation): string[] {
  return REQUIRED[operation] ?? [];
}

export function isForgePrToolOperation(value: string): value is ForgePrToolOperation {
  return (FORGE_PR_TOOL_OPERATIONS as readonly string[]).includes(value);
}

/** The policy group that governs one call. Approving or blocking a PR is a merge-class decision. */
export function forgePrToolGroup(operation: ForgePrToolOperation, args: Pick<ForgePrToolArgs, "event">): ForgeAgentToolGroup {
  if ((FORGE_PR_READ_OPERATIONS as readonly string[]).includes(operation)) return "read";
  if (operation === "submit_pull_request_review" && args.event && args.event !== "COMMENT") return "approve_merge";
  return FORGE_AGENT_WRITE_TOOL_GROUPS[operation as ForgeAgentWriteToolName];
}

function fail(message: string): never {
  throw new ForgeReadError("invalid_arguments", message);
}
function text(args: Record<string, unknown>, key: string, max: number, options: { allowEmpty?: boolean } = {}): void {
  const value = args[key];
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > max || (!options.allowEmpty && !value.trim())) fail(`${key} must be a ${options.allowEmpty ? "" : "nonempty "}string of at most ${max} characters.`);
}
function integer(args: Record<string, unknown>, key: string, min: number, max: number): void {
  const value = args[key];
  if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max)) fail(`${key} must be an integer from ${min} to ${max}.`);
}
function oneOf(args: Record<string, unknown>, key: string, values: readonly string[]): void {
  if (args[key] !== undefined && !values.includes(args[key] as string)) fail(`${key} must be one of ${values.join(", ")}.`);
}
function bool(args: Record<string, unknown>, key: string): void {
  if (args[key] !== undefined && typeof args[key] !== "boolean") fail(`${key} must be boolean.`);
}
function names(args: Record<string, unknown>, key: string): void {
  const value = args[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > LABEL_MAX || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 100)) fail(`${key} must be a list of at most ${LABEL_MAX} nonempty names.`);
}
/** Branch names travel in URLs and gh arguments; refuse anything git itself would refuse. */
export function isSafeRefName(value: string): boolean {
  return value.length <= 255
    && ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
    && !/[\s~^:?*[\\]|\.\.|@\{|^[-/.]|[/.]$|\/\/|\.lock$/.test(value);
}

export function validateForgePrToolArgs(operation: string, value: unknown): asserts value is ForgePrToolArgs {
  if (!isForgePrToolOperation(operation) || !value || typeof value !== "object" || Array.isArray(value)) fail("Provide a known GitHub tool operation and an argument object.");
  const args = value as Record<string, unknown>;
  const allowed = ["repository", ...FIELDS[operation]];
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) fail(`Unknown argument for ${operation}: ${unknown}.`);
  for (const key of forgePrToolRequiredFields(operation)) if (args[key] === undefined) fail(`${operation} requires ${key}.`);
  integer(args, "number", 1, Number.MAX_SAFE_INTEGER);
  integer(args, "runId", 1, Number.MAX_SAFE_INTEGER);
  integer(args, "commentId", 1, Number.MAX_SAFE_INTEGER);
  integer(args, "page", 1, 1000);
  integer(args, "perPage", 1, operation === "list_pull_request_review_threads" ? 50 : 100);
  integer(args, "maxChars", 1, 100_000);
  integer(args, "startChar", 0, Number.MAX_SAFE_INTEGER);
  text(args, "url", 2000);
  for (const key of ["branch", "head", "base"]) {
    text(args, key, 255);
    if (typeof args[key] === "string" && !isSafeRefName(key === "head" ? (args[key] as string).replace(/^[\w.-]+:/, "") : args[key] as string)) fail(`${key} is not a valid branch name.`);
  }
  text(args, "path", 4096);
  text(args, "after", 500);
  text(args, "query", 256);
  text(args, "title", 256);
  text(args, "body", FORGE_BODY_MAX_CHARS, { allowEmpty: operation === "update_pull_request" || operation === "update_issue" || operation === "create_pull_request" || operation === "create_issue" });
  text(args, "reviewThreadId", 200);
  text(args, "commitTitle", 256);
  text(args, "commitMessage", FORGE_BODY_MAX_CHARS, { allowEmpty: true });
  if (args.diffSnapshot !== undefined && (typeof args.diffSnapshot !== "string" || !/^[a-f0-9]{64}$/.test(args.diffSnapshot))) fail("diffSnapshot must come from next.diffSnapshot.");
  if ((args.startChar !== undefined && args.startChar !== 0) !== (args.diffSnapshot !== undefined)) fail("Pass both startChar and diffSnapshot from the previous diff page.");
  for (const key of ["commitId", "expectedHeadSha"]) if (args[key] !== undefined && (typeof args[key] !== "string" || !SHA.test(args[key] as string))) fail(`${key} must be a full commit SHA.`);
  oneOf(args, "state", operation === "list_pull_requests" || operation === "search_issues" ? ["open", "closed", "all"] : ["open", "closed"]);
  oneOf(args, "kind", ["pr", "issue"]);
  oneOf(args, "stateReason", ["completed", "not_planned", "reopened"]);
  oneOf(args, "event", ["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
  oneOf(args, "method", ["merge", "squash", "rebase"]);
  for (const key of ["draft", "includePatch", "unresolvedOnly", "resolved"]) bool(args, key);
  for (const key of ["addLabels", "removeLabels", "reviewers"]) names(args, key);
  if (typeof args.query === "string" && /(^|\s)-?(?:repo|org|user|owner):/i.test(args.query)) fail("query searches this thread's repository only; remove repo:, org:, user: and owner: qualifiers.");
  if (args.attachments !== undefined) {
    const attachments = args.attachments;
    if (!Array.isArray(attachments) || attachments.length > FORGE_ATTACHMENTS_MAX) fail(`attachments must be a list of at most ${FORGE_ATTACHMENTS_MAX} files.`);
    for (const item of attachments) {
      const a = item as Record<string, unknown>;
      if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).some((key) => key !== "path" && key !== "alt")
        || typeof a.path !== "string" || !a.path.startsWith("/") || a.path.length > 4096 || a.path.includes("#")
        || (a.alt !== undefined && (typeof a.alt !== "string" || a.alt.length > 200 || /[\r\n]/.test(a.alt)))) {
        fail("Each attachment needs an absolute path without '#', and optional one-line alt text of at most 200 characters.");
      }
    }
    if (attachments.length && (operation === "update_pull_request" || operation === "update_issue") && args.body === undefined) fail("Attachments on an edit need the full new body, because GitHub stores them in the body.");
  }
  if (args.comments !== undefined) {
    if (operation !== "submit_pull_request_review" || !Array.isArray(args.comments) || args.comments.length > 50) fail("comments must be a list of at most 50 inline review comments.");
    for (const item of args.comments as unknown[]) {
      const c = item as Record<string, unknown>;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((key) => !["path", "line", "side", "startLine", "startSide", "body"].includes(key))
        || typeof c.path !== "string" || !c.path || c.path.length > 4096 || !Number.isSafeInteger(c.line) || Number(c.line) < 1
        || (c.startLine !== undefined && (!Number.isSafeInteger(c.startLine) || Number(c.startLine) < 1 || Number(c.startLine) >= Number(c.line)))
        || (c.side !== undefined && c.side !== "LEFT" && c.side !== "RIGHT") || (c.startSide !== undefined && c.startSide !== "LEFT" && c.startSide !== "RIGHT")
        || typeof c.body !== "string" || !c.body.trim() || c.body.length > FORGE_BODY_MAX_CHARS) {
        fail("Each review comment needs path, line (startLine below line for a range), optional LEFT/RIGHT side, and a nonempty body.");
      }
    }
  }
  if (operation === "submit_pull_request_review" && args.event !== "APPROVE" && !(typeof args.body === "string" && args.body.trim()) && !(Array.isArray(args.comments) && args.comments.length)) {
    fail("A COMMENT or REQUEST_CHANGES review needs a body or inline comments.");
  }
  if (operation === "reply_to_review_comment" && (args.commentId === undefined) === (args.reviewThreadId === undefined)) fail("reply_to_review_comment needs exactly one of commentId or reviewThreadId.");
  if (operation === "update_pull_request" && !["title", "body", "base", "state", "draft", "attachments", "addLabels", "removeLabels", "reviewers"].some((key) => args[key] !== undefined)) fail("update_pull_request needs at least one change.");
  if (operation === "update_issue" && !["title", "body", "state", "stateReason", "attachments", "addLabels", "removeLabels"].some((key) => args[key] !== undefined)) fail("update_issue needs at least one change.");
  if (operation === "get_pull_request" && args.url !== undefined && args.number !== undefined) fail("Pass number or url, not both.");
}
