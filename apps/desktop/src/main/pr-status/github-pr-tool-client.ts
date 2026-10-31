import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildPwrAgentChildProcessEnv } from "../child-process-env";
import { discoverGhCommands } from "../settings/gh-discovery";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { redactForgeLog, type ForgeCiClient } from "./forge-ci-client";
import { ForgeReadError, repositoryUrl, type ForgeRepository } from "./forge-tool-contract";
import type { ForgeAttachment, ForgePrToolArgs, ForgePrToolOperation } from "./forge-pr-tool-contract";
import {
  BODY_READ_MAX_CHARS, COMMENT_READ_MAX_CHARS, UNTRUSTED, forgeWebUrl, num, pageUnifiedDiff, payloadItems, payloadObject, positive, readValidatedAttachment, str, untrusted, validateForgeAttachments,
  type ForgePrToolContext, type Payload,
} from "./forge-pr-tool-shared";

const execFileAsync = promisify(execFile);

export type GhRunResult = { stdout: string; stderr: string; exitCode: number };
export type GhRunner = (args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs: number }) => Promise<GhRunResult>;

const object = (value: unknown) => payloadObject(value, "GitHub");
const items = (value: unknown) => payloadItems(value, "GitHub");
function login(value: unknown): string | undefined {
  return value && typeof value === "object" ? str((value as Payload).login, 200) : undefined;
}
function logins(value: unknown): string[] {
  return Array.isArray(value) ? value.map(login).filter((name): name is string => Boolean(name)) : [];
}
function labelNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map((label) => typeof label === "string" ? label : label && typeof label === "object" ? str((label as Payload).name, 200) : undefined).filter((name): name is string => Boolean(name)) : [];
}
function pullRequestSummary(r: ForgeRepository, p: Payload) {
  const number = positive(p.number, "pull request number");
  const head = p.head && typeof p.head === "object" ? p.head as Payload : {};
  const base = p.base && typeof p.base === "object" ? p.base as Payload : {};
  const headRepo = head.repo && typeof head.repo === "object" ? head.repo as Payload : {};
  return {
    number, title: str(p.title, 1000), state: str(p.state, 20), draft: p.draft === true,
    merged: p.merged === true || typeof p.merged_at === "string",
    mergeable: typeof p.mergeable === "boolean" ? p.mergeable : null, mergeableState: str(p.mergeable_state, 40),
    author: login(p.user),
    head: { ref: str(head.ref, 255), sha: str(head.sha, 64), repository: str(headRepo.full_name, 300) },
    base: { ref: str(base.ref, 255), sha: str(base.sha, 64) },
    labels: labelNames(p.labels), requestedReviewers: logins(p.requested_reviewers), assignees: logins(p.assignees),
    additions: num(p.additions), deletions: num(p.deletions), changedFiles: num(p.changed_files), commits: num(p.commits),
    comments: num(p.comments), reviewComments: num(p.review_comments), autoMerge: p.auto_merge ? true : p.auto_merge === null ? false : undefined,
    createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), closedAt: str(p.closed_at, 40), mergedAt: str(p.merged_at, 40),
    url: forgeWebUrl(r, p.html_url, `/pull/${number}`),
  };
}
function issueSummary(r: ForgeRepository, p: Payload) {
  const number = positive(p.number, "issue number");
  const isPullRequest = Boolean(p.pull_request);
  return {
    number, isPullRequest, title: str(p.title, 1000), state: str(p.state, 20), stateReason: str(p.state_reason, 40),
    author: login(p.user), labels: labelNames(p.labels), assignees: logins(p.assignees), comments: num(p.comments),
    createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), closedAt: str(p.closed_at, 40),
    url: forgeWebUrl(r, p.html_url, `/${isPullRequest ? "pull" : "issues"}/${number}`),
  };
}
function commentSummary(r: ForgeRepository, p: Payload) {
  return { id: positive(p.id, "comment id"), author: login(p.user), body: untrusted(p.body, COMMENT_READ_MAX_CHARS), createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), url: forgeWebUrl(r, p.html_url, "") };
}

async function defaultGhRunner(args: string[], options: { cwd?: string; signal?: AbortSignal; timeoutMs: number }): Promise<GhRunResult> {
  const discovery = await discoverGhCommands({ configuredCommand: getDesktopSettingsService().resolveGhCommandPreference() });
  if (!discovery.selectedCommand) throw new ForgeReadError("unavailable", "Install GitHub CLI or select its path in Settings → Git.");
  try {
    const { stdout, stderr } = await execFileAsync(discovery.selectedCommand, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...buildPwrAgentChildProcessEnv(process.env), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
      encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted) throw new ForgeReadError("cancelled", "GitHub request cancelled.");
    const failure = error as { stdout?: string; stderr?: string; code?: unknown };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", exitCode: typeof failure.code === "number" ? failure.code : 1 };
  }
}

function firstLine(value: string): string {
  return redactForgeLog(value.trim().split("\n").find((line) => line.trim()) ?? "").slice(0, 500);
}
function lastUrl(value: string, host: string): string | undefined {
  const urls = value.match(/https:\/\/[^\s]+/g) ?? [];
  return urls.reverse().find((url) => { try { return new URL(url).host === host; } catch { return false; } });
}

export class GithubPrToolClient {
  constructor(private readonly options: {
    ci: Pick<ForgeCiClient, "requestGithub" | "withGithubAdmission">;
    runGh?: GhRunner;
    tempRoots?: string[];
  }) {}

  async execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown> {
    const r = ctx.repository;
    if (r.provider !== "github") throw new ForgeReadError("unsupported_provider", "This tool supports GitHub and GitHub Enterprise repositories. GitLab supports the CI read tools.");
    const repoPath = `repos/${encodeURIComponent(r.owner)}/${encodeURIComponent(r.repo)}`;
    let providerRequests = 0;
    const call = async (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", route: string, body?: unknown, extra: { accept?: string; raw?: boolean } = {}) => {
      providerRequests++;
      return await this.options.ci.requestGithub(r, { method, path: `${repoPath}${route}`, body, ...extra }, ctx.signal);
    };
    const graphql = async (query: string, variables: Record<string, unknown>) => {
      providerRequests++;
      const data = object(object(await this.options.ci.requestGithub(r, { graphql: true, path: "", body: { query, variables } }, ctx.signal)).data);
      return data;
    };
    const page = args.page ?? 1;
    const perPage = args.perPage ?? 20;
    const paging = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    const done = <T extends Record<string, unknown>>(result: T) => ({ repository: r, source: "provider", fetchedAt: Date.now(), providerRequests, ...result });
    const pageInfo = (rows: unknown[]) => ({ page, perPage, nextPage: rows.length >= perPage ? page + 1 : null });

    if (operation === "rerun_failed_ci_jobs") {
      await call("POST", `/actions/runs/${args.runId}/rerun-failed-jobs`);
      return done({ requested: true, runId: args.runId, scope: "failed_jobs_and_dependents", url: `${repositoryUrl(r)}/actions/runs/${args.runId}` });
    }

    const resolvePullRequestNumber = async (): Promise<number> => {
      if (args.number) return args.number;
      if (args.url) {
        let match: RegExpMatchArray | null = null;
        try {
          const url = new URL(args.url);
          match = url.protocol === "https:" && url.host.toLowerCase() === r.host.toLowerCase() ? url.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/|$)/) : null;
        } catch { /* Not a URL. */ }
        if (!match || match[1]!.toLowerCase() !== r.owner.toLowerCase() || match[2]!.toLowerCase() !== r.repo.toLowerCase()) {
          throw new ForgeReadError("forbidden", "The pull request URL is outside this thread's repository.");
        }
        return Number(match[3]);
      }
      const branch = args.branch ?? ctx.branch;
      const attached = ctx.attached.find((pr) => !branch || pr.headRefName === branch);
      if (attached) return attached.number;
      if (!branch || branch === "HEAD") throw new ForgeReadError("not_found", "This thread has no attached pull request or branch. Pass number, url or branch.");
      const rows = items(await call("GET", `/pulls?${new URLSearchParams({ head: `${r.owner}:${branch}`, state: "all", sort: "updated", direction: "desc", per_page: "5" })}`));
      if (!rows.length) throw new ForgeReadError("not_found", `No pull request has head ${r.owner}:${branch}. A fork's pull request needs number or url.`);
      return positive(rows[0]!.number, "pull request number");
    };
    const readPullRequest = async (number: number, withBody: boolean) => {
      const p = object(await call("GET", `/pulls/${number}`));
      return { ...pullRequestSummary(r, p), ...(withBody ? { body: untrusted(p.body, BODY_READ_MAX_CHARS) } : {}), nodeId: str(p.node_id, 200) };
    };
    // A node id names any thread the account can see. Check it belongs to this repository first.
    const assertReviewThreadInRepository = async (id: string): Promise<Payload> => {
      const node = object(object(await graphql("query($id:ID!){node(id:$id){... on PullRequestReviewThread{id isResolved pullRequest{number repository{nameWithOwner}}}}}", { id })).node ?? {});
      const owner = node.pullRequest && typeof node.pullRequest === "object" ? node.pullRequest as Payload : undefined;
      const repoName = owner?.repository && typeof owner.repository === "object" ? str((owner.repository as Payload).nameWithOwner, 300) : undefined;
      if (!owner || !repoName || repoName.toLowerCase() !== `${r.owner}/${r.repo}`.toLowerCase()) throw new ForgeReadError("forbidden", "That review thread is not in this thread's repository.");
      return owner;
    };
    const withoutNode = <T extends { nodeId?: string }>({ nodeId: _nodeId, ...rest }: T) => rest;

    // gh owns attachment upload: GitHub has no public upload API.
    const runGhWithBody = async (ghArgs: string[], body: string, attachments: ForgeAttachment[]): Promise<{ url: string; warning?: string }> => {
      const validated = await validateForgeAttachments(attachments, { directories: ctx.directories, privateRoots: ctx.privateRoots, ...(this.options.tempRoots ? { tempRoots: this.options.tempRoots } : {}) });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-gh-"));
      try {
        // gh reads private copies of the checked bytes, so a path swapped after
        // validation cannot publish another file. It rewrites a body reference
        // only when it equals the --attach path byte-for-byte, so references
        // move to the copy.
        const attachArgs: string[] = [];
        for (const [index, attachment] of validated.entries()) {
          const copyDir = path.join(dir, String(index));
          await fs.mkdir(copyDir, { mode: 0o700 });
          const copy = path.join(copyDir, path.basename(attachment.path));
          await fs.writeFile(copy, await readValidatedAttachment(attachment), { mode: 0o600 });
          body = body.split(`](${attachment.path})`).join(`](${copy})`);
          attachArgs.push("--attach", attachment.alt ? `${copy}#${attachment.alt}` : copy);
        }
        const bodyFile = path.join(dir, "body.md");
        await fs.writeFile(bodyFile, body, { encoding: "utf8", mode: 0o600 });
        const repoSpec = r.host === "github.com" ? `${r.owner}/${r.repo}` : `${r.host}/${r.owner}/${r.repo}`;
        const run = this.options.runGh ?? defaultGhRunner;
        providerRequests++;
        const result = await this.options.ci.withGithubAdmission(r, ctx.signal, async () => await run([...ghArgs, "-R", repoSpec, "--body-file", bodyFile, ...attachArgs], { cwd: ctx.directories[0] ?? dir, signal: ctx.signal, timeoutMs: 120_000 }));
        const url = lastUrl(result.stdout, r.host);
        if (!url && /unknown flag:? --attach/i.test(result.stderr)) {
          throw new ForgeReadError("unavailable", "Attaching files needs GitHub CLI 2.99 or later. Update gh (Settings → Git shows its version), or call again without attachments.");
        }
        if (!url) throw new ForgeReadError("provider_error", `gh ${ghArgs.slice(0, 2).join(" ")} failed: ${firstLine(result.stderr) || `exit ${result.exitCode}`}`);
        // gh still prints the URL when some attachments failed to upload.
        return { url, ...(result.exitCode !== 0 ? { warning: `Some attachments did not upload: ${firstLine(result.stderr)}` } : {}) };
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    };
    const numberFromUrl = (url: string, kind: "pull" | "issues"): number => {
      const match = new URL(url).pathname.match(kind === "pull" ? /\/pull\/(\d+)/ : /\/(?:issues|pull)\/(\d+)/);
      if (!match) throw new ForgeReadError("invalid_response", "gh did not return the new item's URL.");
      return Number(match[1]);
    };
    const followUps: string[] = [];
    const attempt = async (what: string, work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { followUps.push(`${what}: ${error instanceof ForgeReadError ? error.message : "request failed"}`); }
    };
    const applyLabelsAndReviewers = async (number: number, isPullRequest: boolean) => {
      if (args.addLabels?.length) await attempt("Adding labels", () => call("POST", `/issues/${number}/labels`, { labels: args.addLabels }));
      for (const label of args.removeLabels ?? []) {
        await attempt(`Removing label ${label}`, async () => {
          try { await call("DELETE", `/issues/${number}/labels/${encodeURIComponent(label)}`); }
          catch (error) { if (!(error instanceof ForgeReadError && error.code === "not_found")) throw error; }
        });
      }
      if (isPullRequest && args.reviewers?.length) {
        const users = args.reviewers.filter((name) => !name.includes("/"));
        const teams = args.reviewers.filter((name) => name.includes("/")).map((name) => name.split("/").pop()!);
        await attempt("Requesting reviewers", () => call("POST", `/pulls/${number}/requested_reviewers`, { reviewers: users, team_reviewers: teams }));
      }
    };
    const writeResult = <T extends Record<string, unknown>>(result: T) => done({ ...result, ...(followUps.length ? { followUpErrors: followUps } : {}) });

    switch (operation) {
      case "get_pull_request": {
        const pr = withoutNode(await readPullRequest(await resolvePullRequestNumber(), true));
        return done({ pullRequest: pr, trust: "untrusted", warning: UNTRUSTED });
      }
      case "list_pull_requests": {
        const query = new URLSearchParams({ state: args.state ?? "open", sort: "updated", direction: "desc", page: String(page), per_page: String(perPage) });
        if (args.head) query.set("head", args.head.includes(":") ? args.head : `${r.owner}:${args.head}`);
        if (args.base) query.set("base", args.base);
        const rows = items(await call("GET", `/pulls?${query}`));
        return done({ pullRequests: rows.slice(0, perPage).map((p) => pullRequestSummary(r, p)), ...pageInfo(rows) });
      }
      case "list_pull_request_files": {
        const rows = items(await call("GET", `/pulls/${args.number}/files?${paging}`));
        const files = rows.slice(0, perPage).map((f) => ({
          path: str(f.filename, 4096), previousPath: str(f.previous_filename, 4096), status: str(f.status, 20),
          additions: num(f.additions), deletions: num(f.deletions), changes: num(f.changes),
          ...(args.includePatch ? { patch: untrusted(f.patch, 4000) } : {}),
        }));
        return done({ number: args.number, files, ...pageInfo(rows), limit: "GitHub lists at most 3,000 files per pull request." });
      }
      case "get_pull_request_diff": {
        let raw: unknown;
        try {
          raw = await call("GET", `/pulls/${args.number}`, undefined, { accept: "application/vnd.github.diff", raw: true });
        } catch (error) {
          if (error instanceof ForgeReadError && /HTTP 406/.test(error.message)) throw new ForgeReadError("diff_too_large", "GitHub will not render this diff. Use list_pull_request_files with includePatch, or read the files locally.");
          throw error;
        }
        if (typeof raw !== "string") throw new ForgeReadError("invalid_response", "GitHub returned an invalid diff.");
        return done(pageUnifiedDiff(raw, args));
      }
      case "list_pull_request_reviews": {
        const rows = items(await call("GET", `/pulls/${args.number}/reviews?${paging}`));
        return done({
          number: args.number, trust: "untrusted", warning: UNTRUSTED, ...pageInfo(rows),
          reviews: rows.slice(0, perPage).map((p) => ({ id: positive(p.id, "review id"), author: login(p.user), state: str(p.state, 40), body: untrusted(p.body, COMMENT_READ_MAX_CHARS), commitId: str(p.commit_id, 64), submittedAt: str(p.submitted_at, 40), url: forgeWebUrl(r, p.html_url, `/pull/${args.number}`) })),
        });
      }
      case "list_pull_request_review_threads": {
        const data = await graphql(`query($owner:String!,$repo:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:$first,after:$after){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line originalLine startLine diffSide resolvedBy{login} comments(first:20){totalCount nodes{databaseId author{login} body createdAt url}}}}}}}`,
          { owner: r.owner, repo: r.repo, number: args.number, first: args.perPage ?? 20, after: args.after ?? null });
        const pullRequest = object(object(data.repository).pullRequest);
        const connection = object(pullRequest.reviewThreads);
        const info = object(connection.pageInfo);
        const threads = items(connection.nodes).map((t) => {
          const comments = object(t.comments);
          return {
            reviewThreadId: str(t.id, 200), isResolved: t.isResolved === true, isOutdated: t.isOutdated === true,
            path: str(t.path, 4096), line: num(t.line) ?? null, originalLine: num(t.originalLine) ?? null, startLine: num(t.startLine) ?? null, side: str(t.diffSide, 10), resolvedBy: login(t.resolvedBy),
            commentCount: num(comments.totalCount),
            comments: items(comments.nodes).map((c) => ({ commentId: num(c.databaseId), author: login(c.author), body: untrusted(c.body, COMMENT_READ_MAX_CHARS), createdAt: str(c.createdAt, 40), url: forgeWebUrl(r, c.url, `/pull/${args.number}`) })),
          };
        });
        return done({
          number: args.number, trust: "untrusted", warning: UNTRUSTED,
          threads: args.unresolvedOnly ? threads.filter((t) => !t.isResolved) : threads,
          filteredUnresolved: args.unresolvedOnly === true,
          next: info.hasNextPage === true ? { after: str(info.endCursor, 500) } : null,
          usage: "Reply with reply_to_review_comment using a commentId; resolve with resolve_review_thread using reviewThreadId.",
        });
      }
      case "get_issue": {
        const p = object(await call("GET", `/issues/${args.number}`));
        return done({ issue: { ...issueSummary(r, p), body: untrusted(p.body, BODY_READ_MAX_CHARS) }, trust: "untrusted", warning: UNTRUSTED });
      }
      case "list_issue_comments": {
        const rows = items(await call("GET", `/issues/${args.number}/comments?${paging}`));
        return done({ number: args.number, comments: rows.slice(0, perPage).map((p) => commentSummary(r, p)), trust: "untrusted", warning: UNTRUSTED, ...pageInfo(rows), scope: "Conversation comments. Inline review comments are in list_pull_request_review_threads." });
      }
      case "search_issues": {
        const qualifiers = [`repo:${r.owner}/${r.repo}`, args.kind === "pr" ? "is:pr" : args.kind === "issue" ? "is:issue" : "", args.state === "open" ? "is:open" : args.state === "closed" ? "is:closed" : ""].filter(Boolean);
        providerRequests++;
        const payload = object(await this.options.ci.requestGithub(r, { path: `search/issues?${new URLSearchParams({ q: `${qualifiers.join(" ")} ${args.query}`, page: String(page), per_page: String(perPage) })}` }, ctx.signal));
        const rows = items(payload.items);
        return done({ totalCount: num(payload.total_count), incompleteResults: payload.incomplete_results === true, results: rows.slice(0, perPage).map((p) => issueSummary(r, p)), ...pageInfo(rows) });
      }

      case "create_pull_request": {
        const head = args.head ?? ctx.branch;
        if (!head || head === "HEAD") throw new ForgeReadError("invalid_arguments", "Pass head: this thread has no checked-out branch. Push the branch first.");
        const base = args.base ?? str(object(await call("GET", "")).default_branch, 255);
        if (!base) throw new ForgeReadError("invalid_response", "GitHub did not report the default branch. Pass base.");
        let number: number;
        let warning: string | undefined;
        if (args.attachments?.length) {
          const created = await runGhWithBody(["pr", "create", "--head", head, "--base", base, "--title", args.title!, ...(args.draft ? ["--draft"] : [])], args.body ?? "", args.attachments);
          number = numberFromUrl(created.url, "pull");
          warning = created.warning;
        } else {
          const created = object(await call("POST", "/pulls", { title: args.title, head, base, body: args.body ?? "", draft: args.draft === true }));
          number = positive(created.number, "pull request number");
        }
        await applyLabelsAndReviewers(number, true);
        const pr = withoutNode(await readPullRequest(number, false));
        return writeResult({ created: true, pullRequest: pr, url: pr.url, ...(warning ? { attachmentWarning: warning } : {}) });
      }
      case "update_pull_request": {
        const current = await readPullRequest(args.number!, false);
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.base !== undefined) patch.base = args.base;
        if (args.state !== undefined) patch.state = args.state;
        if (args.body !== undefined && !args.attachments?.length) patch.body = args.body;
        if (Object.keys(patch).length) await call("PATCH", `/pulls/${args.number}`, patch);
        let warning: string | undefined;
        if (args.attachments?.length) warning = (await runGhWithBody(["pr", "edit", String(args.number)], args.body!, args.attachments)).warning;
        if (args.draft !== undefined && args.draft !== current.draft) {
          if (!current.nodeId) throw new ForgeReadError("invalid_response", "GitHub did not return the pull request's node id.");
          await graphql(args.draft
            ? "mutation($id:ID!){convertPullRequestToDraft(input:{pullRequestId:$id}){pullRequest{isDraft}}}"
            : "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}", { id: current.nodeId });
        }
        await applyLabelsAndReviewers(args.number!, true);
        const pr = withoutNode(await readPullRequest(args.number!, false));
        return writeResult({ updated: true, pullRequest: pr, url: pr.url, ...(warning ? { attachmentWarning: warning } : {}) });
      }
      case "add_issue_comment": {
        if (args.attachments?.length) {
          const issue = object(await call("GET", `/issues/${args.number}`));
          const created = await runGhWithBody([issue.pull_request ? "pr" : "issue", "comment", String(args.number)], args.body!, args.attachments);
          return writeResult({ created: true, number: args.number, url: created.url, ...(created.warning ? { attachmentWarning: created.warning } : {}) });
        }
        const comment = object(await call("POST", `/issues/${args.number}/comments`, { body: args.body }));
        return writeResult({ created: true, number: args.number, commentId: positive(comment.id, "comment id"), url: forgeWebUrl(r, comment.html_url, `/issues/${args.number}`) });
      }
      case "reply_to_review_comment": {
        if (args.reviewThreadId) {
          await assertReviewThreadInRepository(args.reviewThreadId);
          const data = await graphql("mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{databaseId url}}}", { id: args.reviewThreadId, body: args.body });
          const comment = object(object(data.addPullRequestReviewThreadReply).comment);
          return writeResult({ created: true, number: args.number, reviewThreadId: args.reviewThreadId, commentId: num(comment.databaseId), url: forgeWebUrl(r, comment.url, `/pull/${args.number}`) });
        }
        const reply = object(await call("POST", `/pulls/${args.number}/comments/${args.commentId}/replies`, { body: args.body }));
        return writeResult({ created: true, number: args.number, inReplyTo: args.commentId, commentId: positive(reply.id, "comment id"), url: forgeWebUrl(r, reply.html_url, `/pull/${args.number}`) });
      }
      case "submit_pull_request_review": {
        const review = object(await call("POST", `/pulls/${args.number}/reviews`, {
          event: args.event,
          ...(args.body ? { body: args.body } : {}),
          ...(args.commitId ? { commit_id: args.commitId } : {}),
          ...(args.comments?.length ? { comments: args.comments.map((c) => ({ path: c.path, line: c.line, side: c.side ?? "RIGHT", ...(c.startLine ? { start_line: c.startLine, start_side: c.startSide ?? c.side ?? "RIGHT" } : {}), body: c.body })) } : {}),
        }));
        return writeResult({ submitted: true, number: args.number, reviewId: positive(review.id, "review id"), state: str(review.state, 40), url: forgeWebUrl(r, review.html_url, `/pull/${args.number}`) });
      }
      case "resolve_review_thread": {
        const owner = await assertReviewThreadInRepository(args.reviewThreadId!);
        const mutation = args.resolved
          ? "mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}"
          : "mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}";
        const data = await graphql(mutation, { id: args.reviewThreadId });
        const thread = object(object(data[args.resolved ? "resolveReviewThread" : "unresolveReviewThread"]).thread);
        return writeResult({ reviewThreadId: args.reviewThreadId, number: num(owner?.number), isResolved: thread.isResolved === true });
      }
      case "create_issue": {
        let number: number;
        let warning: string | undefined;
        if (args.attachments?.length) {
          const created = await runGhWithBody(["issue", "create", "--title", args.title!], args.body ?? "", args.attachments);
          number = numberFromUrl(created.url, "issues");
          warning = created.warning;
        } else {
          number = positive(object(await call("POST", "/issues", { title: args.title, body: args.body ?? "" })).number, "issue number");
        }
        await applyLabelsAndReviewers(number, false);
        const issue = issueSummary(r, object(await call("GET", `/issues/${number}`)));
        return writeResult({ created: true, issue, url: issue.url, ...(warning ? { attachmentWarning: warning } : {}) });
      }
      case "update_issue": {
        const patch: Record<string, unknown> = {};
        if (args.title !== undefined) patch.title = args.title;
        if (args.state !== undefined) patch.state = args.state;
        if (args.stateReason !== undefined) patch.state_reason = args.stateReason;
        if (args.body !== undefined && !args.attachments?.length) patch.body = args.body;
        if (Object.keys(patch).length) await call("PATCH", `/issues/${args.number}`, patch);
        let warning: string | undefined;
        if (args.attachments?.length) warning = (await runGhWithBody(["issue", "edit", String(args.number)], args.body!, args.attachments)).warning;
        await applyLabelsAndReviewers(args.number!, false);
        const issue = issueSummary(r, object(await call("GET", `/issues/${args.number}`)));
        return writeResult({ updated: true, issue, url: issue.url, ...(warning ? { attachmentWarning: warning } : {}) });
      }
      case "merge_pull_request": {
        const method = args.method ?? ctx.defaultMergeMethod();
        let result: Payload;
        try {
          result = object(await call("PUT", `/pulls/${args.number}/merge`, { merge_method: method, sha: args.expectedHeadSha, ...(args.commitTitle ? { commit_title: args.commitTitle } : {}), ...(args.commitMessage !== undefined ? { commit_message: args.commitMessage } : {}) }));
        } catch (error) {
          if (error instanceof ForgeReadError && error.code === "conflict") throw new ForgeReadError("head_changed", `The pull request's head is no longer ${args.expectedHeadSha}. Read it again before merging.`);
          throw error;
        }
        return writeResult({ merged: result.merged === true, number: args.number, method, mergeCommitSha: str(result.sha, 64), message: str(result.message, 500), url: `${repositoryUrl(r)}/pull/${args.number}` });
      }
    }
  }
}
