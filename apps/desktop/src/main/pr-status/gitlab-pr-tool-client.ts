import path from "node:path";
import { redactForgeLog } from "./forge-ci-client";
import { ForgeReadError, repositoryUrl, type ForgeRepository } from "./forge-tool-contract";
import type { ForgePrToolArgs, ForgePrToolOperation } from "./forge-pr-tool-contract";
import {
  BODY_READ_MAX_CHARS, COMMENT_READ_MAX_CHARS, UNTRUSTED, forgeWebUrl, num, pageUnifiedDiff, payloadItems, payloadObject, placeUploadedAttachments, positive, readValidatedAttachment, str, untrusted, validateForgeAttachments,
  type ForgePrToolContext, type Payload,
} from "./forge-pr-tool-shared";
import { GitLabReadError, type GitLabPrFetcher, type GitLabWriteMethod } from "./gitlab-pr-fetcher";

const object = (value: unknown) => payloadObject(value, "GitLab");
const items = (value: unknown) => payloadItems(value, "GitLab");
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
/** Paged /diffs fallback for servers without raw_diffs: at most this many 100-file pages. */
const DIFF_PAGE_LIMIT = 10;
const DRAFT_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s*-)\s*/i;

function username(value: unknown): string | undefined {
  return value && typeof value === "object" ? str((value as Payload).username, 200) : undefined;
}
function usernames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(username).filter((name): name is string => Boolean(name)) : [];
}
function labels(value: unknown): string[] {
  return Array.isArray(value) ? value.map((label) => typeof label === "string" ? label.slice(0, 200) : label && typeof label === "object" ? str((label as Payload).name, 200) : undefined).filter((name): name is string => Boolean(name)) : [];
}
/** GitLab says "opened"; the shared contract says "open", as GitHub does. */
function state(value: unknown): string | undefined {
  return value === "opened" ? "open" : str(value, 20);
}
function diffCounts(diff: unknown): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of typeof diff === "string" ? diff.split("\n") : []) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
function fileStatus(f: Payload): string {
  return f.new_file ? "added" : f.deleted_file ? "removed" : f.renamed_file ? "renamed" : "modified";
}
/** A /diffs entry as one section of a unified diff, so paging and path filters match GitHub's. */
function unifiedSection(f: Payload): string {
  const oldPath = str(f.old_path, 4096) ?? "";
  const newPath = str(f.new_path, 4096) ?? oldPath;
  const header = [`diff --git a/${oldPath} b/${newPath}`];
  if (f.new_file) header.push("new file mode 100644");
  if (f.deleted_file) header.push("deleted file mode 100644");
  header.push(`--- ${f.new_file ? "/dev/null" : `a/${oldPath}`}`, `+++ ${f.deleted_file ? "/dev/null" : `b/${newPath}`}`);
  const body = typeof f.diff === "string" ? f.diff : "";
  return `${header.join("\n")}\n${body}${body.endsWith("\n") || !body ? "" : "\n"}`;
}

function mergeRequestSummary(r: ForgeRepository, p: Payload) {
  const number = positive(p.iid, "merge request number");
  const refs = p.diff_refs && typeof p.diff_refs === "object" ? p.diff_refs as Payload : {};
  const status = str(p.detailed_merge_status ?? p.merge_status, 40);
  return {
    number, title: str(p.title, 1000), state: state(p.state), draft: p.draft === true || p.work_in_progress === true,
    merged: p.state === "merged",
    mergeable: status === "mergeable" || status === "can_be_merged" ? true : p.has_conflicts === true ? false : null, mergeableState: status,
    author: username(p.author),
    head: { ref: str(p.source_branch, 255), sha: str(p.sha ?? refs.head_sha, 64), repository: p.source_project_id !== undefined && p.source_project_id !== p.target_project_id ? "fork" : `${r.owner}/${r.repo}` },
    base: { ref: str(p.target_branch, 255), sha: str(refs.base_sha, 64) },
    labels: labels(p.labels), requestedReviewers: usernames(p.reviewers), assignees: usernames(p.assignees),
    changedFiles: typeof p.changes_count === "string" ? Number.parseInt(p.changes_count, 10) || undefined : num(p.changes_count),
    comments: num(p.user_notes_count),
    createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), closedAt: str(p.closed_at, 40), mergedAt: str(p.merged_at, 40),
    url: forgeWebUrl(r, p.web_url, `/-/merge_requests/${number}`),
  };
}
function issueSummary(r: ForgeRepository, p: Payload, isPullRequest = false) {
  const number = positive(p.iid, isPullRequest ? "merge request number" : "issue number");
  return {
    number, isPullRequest, title: str(p.title, 1000), state: state(p.state), stateReason: undefined,
    author: username(p.author), labels: labels(p.labels), assignees: usernames(p.assignees), comments: num(p.user_notes_count),
    createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), closedAt: str(p.closed_at, 40),
    url: forgeWebUrl(r, p.web_url, `/-/${isPullRequest ? "merge_requests" : "issues"}/${number}`),
  };
}
function noteSummary(r: ForgeRepository, p: Payload, fallback: string) {
  return { id: positive(p.id, "note id"), author: username(p.author), body: untrusted(p.body, COMMENT_READ_MAX_CHARS), createdAt: str(p.created_at, 40), updatedAt: str(p.updated_at, 40), url: `${repositoryUrl(r)}${fallback}#note_${p.id}` };
}

/**
 * GitLab merge requests and issues behind the same tool contract as GitHub.
 * Reads go through glab's read transport and writes through its write
 * transport, both with the existing GitLab concurrency and request budget.
 */
export class GitlabPrToolClient {
  constructor(private readonly options: {
    gitlab: Pick<GitLabPrFetcher, "readApi" | "writeApi" | "uploadProjectFile">;
    tempRoots?: string[];
  }) {}

  async execute(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown> {
    try {
      return await this.run(operation, args, ctx);
    } catch (error) {
      if (ctx.signal?.aborted) throw new ForgeReadError("cancelled", "GitLab request cancelled.");
      if (error instanceof ForgeReadError) throw error;
      if (error instanceof GitLabReadError) {
        const code = error.status === 401 ? "unauthenticated" : error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status === 429 ? "rate_limited" : error.status === 413 ? "response_too_large" : [400, 405, 406, 422].includes(error.status) ? "rejected" : "provider_error";
        throw new ForgeReadError(code, error.reason ? `GitLab returned HTTP ${error.status}: ${redactForgeLog(error.reason)}` : `GitLab returned HTTP ${error.status}. Check glab login, api permission and project access.`);
      }
      throw new ForgeReadError("provider_error", error instanceof Error && /^(GitLab|PR status|Invalid GitLab)/.test(error.message) ? error.message : "GitLab request failed. Check glab login, api permission, project access and connectivity.");
    }
  }

  private async run(operation: ForgePrToolOperation, args: ForgePrToolArgs, ctx: ForgePrToolContext): Promise<unknown> {
    const r = ctx.repository;
    const gitlab = this.options.gitlab;
    const project = `${r.owner}/${r.repo}`;
    const base = `projects/${encodeURIComponent(project)}`;
    let providerRequests = 0;
    const get = async (route: string, raw = false) => { providerRequests++; return await gitlab.readApi<unknown>(r.host, `${base}${route}`, ctx.signal, raw); };
    const write = async (method: GitLabWriteMethod, route: string, body?: unknown) => { providerRequests++; return await gitlab.writeApi<unknown>(r.host, `${base}${route}`, method, body ?? {}, ctx.signal); };
    const page = args.page ?? 1;
    const perPage = args.perPage ?? 20;
    const paging = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    const done = <T extends Record<string, unknown>>(result: T) => ({ repository: r, source: "provider", fetchedAt: Date.now(), providerRequests, ...result });
    const pageInfo = (rows: unknown[]) => ({ page, perPage, nextPage: rows.length >= perPage ? page + 1 : null });

    if (operation === "rerun_failed_ci_jobs") {
      await write("POST", `/pipelines/${args.runId}/retry`);
      return done({ requested: true, runId: args.runId, scope: "failed_and_canceled_jobs", url: `${repositoryUrl(r)}/-/pipelines/${args.runId}` });
    }
    const notes: string[] = [];
    const writeResult = <T extends Record<string, unknown>>(result: T) => done({ ...result, ...(notes.length ? { notes } : {}) });

    const resolveNumber = async (): Promise<number> => {
      if (args.number) return args.number;
      if (args.url) {
        let match: RegExpMatchArray | null = null;
        try {
          const url = new URL(args.url);
          match = url.protocol === "https:" && url.host.toLowerCase() === r.host.toLowerCase() ? url.pathname.match(/^\/(.+)\/-\/merge_requests\/([1-9]\d*)(?:\/|$)/) : null;
        } catch { /* Not a URL. */ }
        if (!match || match[1] !== project) throw new ForgeReadError("forbidden", "The merge request URL is outside this thread's repository.");
        return Number(match[2]);
      }
      const branch = args.branch ?? ctx.branch;
      const attached = ctx.attached.find((mr) => !branch || mr.headRefName === branch);
      if (attached) return attached.number;
      if (!branch || branch === "HEAD") throw new ForgeReadError("not_found", "This thread has no attached merge request or branch. Pass number, url or branch.");
      const rows = items(await get(`/merge_requests?${new URLSearchParams({ source_branch: branch, state: "all", order_by: "updated_at", sort: "desc", per_page: "5" })}`));
      if (!rows.length) throw new ForgeReadError("not_found", `No merge request has source branch ${branch}.`);
      return positive(rows[0]!.iid, "merge request number");
    };
    const readMergeRequest = async (number: number) => object(await get(`/merge_requests/${number}`));
    const userIds = async (names: string[]): Promise<number[]> => {
      const ids: number[] = [];
      for (const name of names.slice(0, 20)) {
        if (name.includes("/")) { notes.push(`GitLab reviewers are users; ${name} was skipped.`); continue; }
        providerRequests++;
        const found = items(await gitlab.readApi<unknown>(r.host, `users?${new URLSearchParams({ username: name })}`, ctx.signal));
        const id = found[0]?.id;
        if (Number.isSafeInteger(id)) ids.push(Number(id));
        else notes.push(`No GitLab user named ${name}.`);
      }
      return ids;
    };
    // GitLab stores uploads per project and links them from Markdown.
    const withAttachments = async (body: string): Promise<{ body: string }> => {
      const validated = await validateForgeAttachments(args.attachments ?? [], { directories: ctx.directories, privateRoots: ctx.privateRoots, ...(this.options.tempRoots ? { tempRoots: this.options.tempRoots } : {}) });
      const uploads = [];
      for (const attachment of validated) {
        providerRequests++;
        const uploaded = await gitlab.uploadProjectFile(r.host, project, { data: await readValidatedAttachment(attachment), name: path.basename(attachment.path) }, ctx.signal);
        uploads.push({ path: attachment.path, alt: attachment.alt, url: uploaded.url, video: VIDEO_EXTENSIONS.has(path.extname(attachment.path).toLowerCase()) });
      }
      return { body: placeUploadedAttachments(body, uploads) };
    };
    const labelChanges = () => ({
      ...(args.addLabels?.length ? { add_labels: args.addLabels.join(",") } : {}),
      ...(args.removeLabels?.length ? { remove_labels: args.removeLabels.join(",") } : {}),
    });
    const findDiscussion = async (number: number, noteId: number): Promise<string> => {
      for (let discussionPage = 1; discussionPage <= 5; discussionPage++) {
        const rows = items(await get(`/merge_requests/${number}/discussions?${new URLSearchParams({ page: String(discussionPage), per_page: "100" })}`));
        const found = rows.find((d) => Array.isArray(d.notes) && d.notes.some((n) => n && typeof n === "object" && (n as Payload).id === noteId));
        if (found) return String(found.id);
        if (rows.length < 100) break;
      }
      throw new ForgeReadError("not_found", `No discussion on !${number} contains comment ${noteId}. Pass reviewThreadId from list_pull_request_review_threads.`);
    };

    switch (operation) {
      case "get_pull_request": {
        const p = await readMergeRequest(await resolveNumber());
        return done({ pullRequest: { ...mergeRequestSummary(r, p), body: untrusted(p.description, BODY_READ_MAX_CHARS) }, trust: "untrusted", warning: UNTRUSTED });
      }
      case "list_pull_requests": {
        const query = new URLSearchParams({ state: args.state === "closed" ? "closed" : args.state === "all" ? "all" : "opened", order_by: "updated_at", sort: "desc", page: String(page), per_page: String(perPage) });
        if (args.head) {
          if (args.head.includes(":")) throw new ForgeReadError("invalid_arguments", "GitLab filters by source branch only. Pass head without an owner.");
          query.set("source_branch", args.head);
        }
        if (args.base) query.set("target_branch", args.base);
        const rows = items(await get(`/merge_requests?${query}`));
        return done({ pullRequests: rows.slice(0, perPage).map((p) => mergeRequestSummary(r, p)), ...pageInfo(rows), ...(args.state === "closed" ? { scope: "GitLab's closed state excludes merged merge requests. Use state all to include them." } : {}) });
      }
      case "list_pull_request_files": {
        const rows = items(await get(`/merge_requests/${args.number}/diffs?${paging}`));
        const files = rows.slice(0, perPage).map((f) => ({
          path: str(f.new_path, 4096), previousPath: f.renamed_file ? str(f.old_path, 4096) : undefined, status: fileStatus(f), ...diffCounts(f.diff),
          ...(args.includePatch ? { patch: untrusted(f.diff, 4000) } : {}),
        }));
        return done({ number: args.number, files, ...pageInfo(rows) });
      }
      case "get_pull_request_diff": {
        let raw: string;
        let filesTruncated = false;
        try {
          const text = await get(`/merge_requests/${args.number}/raw_diffs`, true);
          if (typeof text !== "string") throw new ForgeReadError("invalid_response", "GitLab returned an invalid diff.");
          raw = text;
        } catch (error) {
          // raw_diffs is recent; older servers page the structured /diffs instead.
          if (!(error instanceof GitLabReadError && error.status === 404)) throw error;
          const sections: string[] = [];
          for (let diffPage = 1; diffPage <= DIFF_PAGE_LIMIT; diffPage++) {
            const rows = items(await get(`/merge_requests/${args.number}/diffs?${new URLSearchParams({ page: String(diffPage), per_page: "100" })}`));
            sections.push(...rows.map(unifiedSection));
            if (rows.length < 100) break;
            if (diffPage === DIFF_PAGE_LIMIT) filesTruncated = true;
          }
          raw = sections.join("");
        }
        return done({ ...pageUnifiedDiff(raw, args), ...(filesTruncated ? { filesTruncated: `Only the first ${DIFF_PAGE_LIMIT * 100} files were read. Use list_pull_request_files or a path filter.` } : {}) });
      }
      case "list_pull_request_reviews": {
        const approvals = object(await get(`/merge_requests/${args.number}/approvals`));
        const reviews = Array.isArray(approvals.approved_by)
          ? approvals.approved_by.map((entry) => ({ author: username(entry && typeof entry === "object" ? (entry as Payload).user : undefined), state: "APPROVED" }))
          : [];
        return done({ number: args.number, reviews, page: 1, perPage: reviews.length, nextPage: null, approvalsRequired: num(approvals.approvals_required), approvalsLeft: num(approvals.approvals_left), scope: "GitLab reviews are approvals. Review comments are in list_pull_request_review_threads." });
      }
      case "list_pull_request_review_threads": {
        const threadPage = args.after ? Number.parseInt(args.after, 10) : 1;
        if (!Number.isSafeInteger(threadPage) || threadPage < 1) throw new ForgeReadError("invalid_arguments", "after must come from next.after.");
        const threadsPerPage = args.perPage ?? 20;
        const rows = items(await get(`/merge_requests/${args.number}/discussions?${new URLSearchParams({ page: String(threadPage), per_page: String(threadsPerPage) })}`));
        const threads = rows.flatMap((d) => {
          const all = Array.isArray(d.notes) ? d.notes.filter((n): n is Payload => Boolean(n) && typeof n === "object" && !(n as Payload).system) : [];
          const first = all[0];
          // Only resolvable discussions are review threads; single notes are conversation comments.
          if (!first || first.resolvable !== true) return [];
          const position = first.position && typeof first.position === "object" ? first.position as Payload : {};
          const resolvable = all.filter((n) => n.resolvable === true);
          return [{
            reviewThreadId: str(d.id, 200), isResolved: resolvable.length > 0 && resolvable.every((n) => n.resolved === true), isOutdated: false,
            path: str(position.new_path ?? position.old_path, 4096), line: num(position.new_line) ?? num(position.old_line) ?? null, originalLine: null, startLine: null,
            side: position.new_line !== undefined && position.new_line !== null ? "RIGHT" : position.old_line !== undefined && position.old_line !== null ? "LEFT" : undefined,
            resolvedBy: username(first.resolved_by), commentCount: all.length,
            comments: all.slice(0, 20).map((n) => ({ commentId: num(n.id), author: username(n.author), body: untrusted(n.body, COMMENT_READ_MAX_CHARS), createdAt: str(n.created_at, 40), url: `${repositoryUrl(r)}/-/merge_requests/${args.number}#note_${n.id}` })),
          }];
        });
        return done({
          number: args.number, trust: "untrusted", warning: UNTRUSTED,
          threads: args.unresolvedOnly ? threads.filter((t) => !t.isResolved) : threads,
          filteredUnresolved: args.unresolvedOnly === true,
          next: rows.length >= threadsPerPage ? { after: String(threadPage + 1) } : null,
          usage: "Reply with reply_to_review_comment and reviewThreadId; resolve with resolve_review_thread, reviewThreadId and number.",
        });
      }
      case "get_issue": {
        const p = object(await get(`/issues/${args.number}`));
        return done({ issue: { ...issueSummary(r, p), body: untrusted(p.description, BODY_READ_MAX_CHARS) }, trust: "untrusted", warning: UNTRUSTED, scope: "GitLab numbers issues and merge requests separately. Use get_pull_request for a merge request." });
      }
      case "list_issue_comments": {
        const kind = args.kind === "pr" ? "merge_requests" : "issues";
        const rows = items(await get(`/${kind}/${args.number}/notes?${new URLSearchParams({ sort: "asc", order_by: "created_at", page: String(page), per_page: String(perPage) })}`));
        const comments = rows.slice(0, perPage).filter((n) => !n.system).map((n) => noteSummary(r, n, `/-/${kind}/${args.number}`));
        return done({ number: args.number, kind: args.kind ?? "issue", comments, trust: "untrusted", warning: UNTRUSTED, ...pageInfo(rows), scope: "GitLab system notes are omitted. Pass kind pr for a merge request." });
      }
      case "search_issues": {
        const stateParam = args.state === "open" ? "opened" : args.state === "closed" ? "closed" : "all";
        const query = new URLSearchParams({ search: args.query!, state: stateParam, order_by: "updated_at", sort: "desc", page: String(page), per_page: String(perPage) });
        const results: Array<ReturnType<typeof issueSummary>> = [];
        let full = false;
        if (args.kind !== "pr") {
          const rows = items(await get(`/issues?${query}`));
          full ||= rows.length >= perPage;
          results.push(...rows.slice(0, perPage).map((p) => issueSummary(r, p)));
        }
        if (args.kind !== "issue") {
          const rows = items(await get(`/merge_requests?${query}`));
          full ||= rows.length >= perPage;
          results.push(...rows.slice(0, perPage).map((p) => issueSummary(r, p, true)));
        }
        results.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
        return done({ totalCount: undefined, incompleteResults: false, results, page, perPage, nextPage: full ? page + 1 : null, syntax: "GitLab matches the words in titles and descriptions. GitHub search qualifiers do not apply." });
      }

      case "create_pull_request": {
        const head = args.head ?? ctx.branch;
        if (!head || head === "HEAD") throw new ForgeReadError("invalid_arguments", "Pass head: this thread has no checked-out branch. Push the branch first.");
        if (head.includes(":")) throw new ForgeReadError("invalid_arguments", "Opening a merge request from a fork is not supported here. Pass the source branch name.");
        const target = args.base ?? str(object(await get("")).default_branch, 255);
        if (!target) throw new ForgeReadError("invalid_response", "GitLab did not report the default branch. Pass base.");
        const { body } = await withAttachments(args.body ?? "");
        const reviewerIds = args.reviewers?.length ? await userIds(args.reviewers) : [];
        const title = args.draft && !DRAFT_PREFIX.test(args.title!) ? `Draft: ${args.title}` : args.title;
        const created = object(await write("POST", "/merge_requests", {
          source_branch: head, target_branch: target, title, description: body,
          ...(args.addLabels?.length ? { labels: args.addLabels.join(",") } : {}),
          ...(reviewerIds.length ? { reviewer_ids: reviewerIds } : {}),
        }));
        const pr = mergeRequestSummary(r, created);
        return writeResult({ created: true, pullRequest: pr, url: pr.url });
      }
      case "update_pull_request": {
        const current = await readMergeRequest(args.number!);
        const change: Record<string, unknown> = { ...labelChanges() };
        let title = args.title ?? str(current.title, 1000) ?? "";
        if (args.draft !== undefined) title = args.draft ? (DRAFT_PREFIX.test(title) ? title : `Draft: ${title}`) : title.replace(DRAFT_PREFIX, "");
        if (args.title !== undefined || args.draft !== undefined) change.title = title;
        if (args.body !== undefined) change.description = (await withAttachments(args.body)).body;
        if (args.base !== undefined) change.target_branch = args.base;
        if (args.state !== undefined) change.state_event = args.state === "closed" ? "close" : "reopen";
        if (args.reviewers?.length) change.reviewer_ids = [...new Set([...(Array.isArray(current.reviewers) ? current.reviewers.map((u) => (u as Payload)?.id).filter(Number.isSafeInteger) as number[] : []), ...await userIds(args.reviewers)])];
        const updated = object(await write("PUT", `/merge_requests/${args.number}`, change));
        const pr = mergeRequestSummary(r, updated);
        return writeResult({ updated: true, pullRequest: pr, url: pr.url });
      }
      case "add_issue_comment": {
        const kind = args.kind === "pr" ? "merge_requests" : "issues";
        const { body } = await withAttachments(args.body!);
        const note = object(await write("POST", `/${kind}/${args.number}/notes`, { body }));
        return writeResult({ created: true, number: args.number, kind: args.kind ?? "issue", commentId: positive(note.id, "note id"), url: `${repositoryUrl(r)}/-/${kind}/${args.number}#note_${note.id}` });
      }
      case "reply_to_review_comment": {
        const discussion = args.reviewThreadId ?? await findDiscussion(args.number!, args.commentId!);
        const note = object(await write("POST", `/merge_requests/${args.number}/discussions/${encodeURIComponent(discussion)}/notes`, { body: args.body }));
        return writeResult({ created: true, number: args.number, reviewThreadId: discussion, commentId: positive(note.id, "note id"), url: `${repositoryUrl(r)}/-/merge_requests/${args.number}#note_${note.id}` });
      }
      case "submit_pull_request_review": {
        if (args.event === "REQUEST_CHANGES") throw new ForgeReadError("unsupported_operation", "GitLab has no request-changes review through its API. Submit a COMMENT review instead.");
        const comments = args.comments ?? [];
        let refs: Payload = {};
        if (comments.length) {
          const mr = await readMergeRequest(args.number!);
          refs = mr.diff_refs && typeof mr.diff_refs === "object" ? mr.diff_refs as Payload : {};
          if (!refs.base_sha || !refs.head_sha || !refs.start_sha) throw new ForgeReadError("invalid_response", "GitLab did not return the merge request's diff refs.");
          if (args.commitId && args.commitId !== refs.head_sha) throw new ForgeReadError("head_changed", `GitLab comments attach to the current head ${String(refs.head_sha)}, not ${args.commitId}.`);
        }
        const posted: number[] = [];
        for (const comment of comments) {
          if (comment.startLine) notes.push(`${comment.path}: GitLab line ranges are not sent; the comment is on line ${comment.line}.`);
          const discussion = object(await write("POST", `/merge_requests/${args.number}/discussions`, {
            body: comment.body,
            position: {
              position_type: "text", base_sha: refs.base_sha, start_sha: refs.start_sha, head_sha: refs.head_sha,
              old_path: comment.path, new_path: comment.path,
              ...(comment.side === "LEFT" ? { old_line: comment.line } : { new_line: comment.line }),
            },
          }));
          const first = Array.isArray(discussion.notes) ? discussion.notes[0] as Payload | undefined : undefined;
          if (first && Number.isSafeInteger(first.id)) posted.push(Number(first.id));
        }
        if (args.body?.trim()) await write("POST", `/merge_requests/${args.number}/notes`, { body: args.body });
        if (args.event === "APPROVE") await write("POST", `/merge_requests/${args.number}/approve`, args.commitId ? { sha: args.commitId } : {});
        return writeResult({ submitted: true, number: args.number, state: args.event === "APPROVE" ? "APPROVED" : "COMMENTED", inlineComments: posted.length, url: `${repositoryUrl(r)}/-/merge_requests/${args.number}` });
      }
      case "resolve_review_thread": {
        if (!args.number) throw new ForgeReadError("invalid_arguments", "GitLab needs the merge request number with reviewThreadId.");
        const discussion = object(await write("PUT", `/merge_requests/${args.number}/discussions/${encodeURIComponent(args.reviewThreadId!)}`, { resolved: args.resolved === true }));
        const all = Array.isArray(discussion.notes) ? discussion.notes.filter((n): n is Payload => Boolean(n) && typeof n === "object" && (n as Payload).resolvable === true) : [];
        return writeResult({ reviewThreadId: args.reviewThreadId, number: args.number, isResolved: all.length > 0 && all.every((n) => n.resolved === true) });
      }
      case "create_issue": {
        const { body } = await withAttachments(args.body ?? "");
        const created = object(await write("POST", "/issues", { title: args.title, description: body, ...(args.addLabels?.length ? { labels: args.addLabels.join(",") } : {}) }));
        const issue = issueSummary(r, created);
        return writeResult({ created: true, issue, url: issue.url });
      }
      case "update_issue": {
        const change: Record<string, unknown> = { ...labelChanges() };
        if (args.title !== undefined) change.title = args.title;
        if (args.body !== undefined) change.description = (await withAttachments(args.body)).body;
        if (args.state !== undefined) change.state_event = args.state === "closed" ? "close" : "reopen";
        if (args.stateReason !== undefined) notes.push("GitLab has no close reason; stateReason was not sent.");
        const issue = issueSummary(r, object(await write("PUT", `/issues/${args.number}`, change)));
        return writeResult({ updated: true, issue, url: issue.url });
      }
      case "merge_pull_request": {
        ctx.assertCanMerge?.(r, args.number!);
        const method = args.method ?? ctx.defaultMergeMethod();
        if (method === "rebase") throw new ForgeReadError("unsupported_operation", "GitLab merges with the project's merge method. Use merge or squash.");
        // GitLab takes one commit message; the title is its first line.
        const message = [args.commitTitle, args.commitMessage].filter((part) => part !== undefined && part !== "").join("\n\n");
        let result: Payload;
        try {
          result = object(await write("PUT", `/merge_requests/${args.number}/merge`, {
            sha: args.expectedHeadSha, squash: method === "squash",
            ...(message ? { [method === "squash" ? "squash_commit_message" : "merge_commit_message"]: message } : {}),
          }));
        } catch (error) {
          if (error instanceof GitLabReadError && error.status === 409) throw new ForgeReadError("head_changed", `The merge request's head is no longer ${args.expectedHeadSha}. Read it again before merging.`);
          throw error;
        }
        return writeResult({ merged: result.state === "merged", number: args.number, method, mergeCommitSha: str(result.merge_commit_sha ?? result.squash_commit_sha, 64), url: forgeWebUrl(r, result.web_url, `/-/merge_requests/${args.number}`) });
      }
    }
  }
}
