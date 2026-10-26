import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ForgeRepository } from "../pr-status/forge-tool-contract";
import { placeUploadedAttachments, type ForgePrToolContext } from "../pr-status/forge-pr-tool-shared";
import { GitLabPrFetcher, GitLabReadError, type GitLabWriteMethod } from "../pr-status/gitlab-pr-fetcher";
import { GitlabPrToolClient } from "../pr-status/gitlab-pr-tool-client";

const repo: ForgeRepository = { provider: "gitlab", host: "gitlab.example.test", owner: "group/sub", repo: "project" };
const projectPath = "projects/group%2Fsub%2Fproject";
const mr = (iid: number, extra: Record<string, unknown> = {}) => ({
  iid, title: "Fixture change", state: "opened", draft: false, description: "Body text", author: { username: "octo" },
  source_branch: "topic", target_branch: "main", sha: "a".repeat(40), diff_refs: { base_sha: "b".repeat(40), start_sha: "c".repeat(40), head_sha: "a".repeat(40) },
  labels: ["bug"], reviewers: [], assignees: [], web_url: `https://gitlab.example.test/group/sub/project/-/merge_requests/${iid}`, ...extra,
});
const ctx = (extra: Partial<ForgePrToolContext> = {}): ForgePrToolContext => ({
  repository: repo, branch: "topic", directories: [], attached: [], privateRoots: [], defaultMergeMethod: () => "squash", ...extra,
});

type Write = { method: GitLabWriteMethod; endpoint: string; body: unknown };
function harness(reads: (endpoint: string, raw: boolean) => unknown, writes: (call: Write) => unknown = () => ({})) {
  const writeCalls: Write[] = [];
  const readCalls: string[] = [];
  const uploads: string[] = [];
  const gitlab = {
    readApi: vi.fn(async (_host: string, endpoint: string, _signal?: AbortSignal, raw = false) => { readCalls.push(endpoint); return reads(endpoint, raw); }),
    writeApi: vi.fn(async (_host: string, endpoint: string, method: GitLabWriteMethod, body: unknown) => { const call = { method, endpoint, body }; writeCalls.push(call); return writes(call); }),
    uploadProjectFile: vi.fn(async (_host: string, _project: string, file: { name: string }) => { uploads.push(file.name); return { url: `/uploads/hash/${file.name}` }; }),
  };
  return { client: new GitlabPrToolClient({ gitlab: gitlab as never, tempRoots: [os.tmpdir()] }), gitlab, writeCalls, readCalls, uploads };
}

describe("GitLab merge request tools", () => {
  it("finds the thread's merge request by source branch and reads it back", async () => {
    const { client, readCalls } = harness((endpoint) => endpoint.includes("/merge_requests?") ? [mr(7)] : mr(7));
    const result = await client.execute("get_pull_request", {}, ctx()) as { pullRequest: Record<string, unknown> };
    expect(readCalls[0]).toBe(`${projectPath}/merge_requests?source_branch=topic&state=all&order_by=updated_at&sort=desc&per_page=5`);
    expect(result.pullRequest).toMatchObject({ number: 7, state: "open", head: { ref: "topic", sha: "a".repeat(40) }, base: { ref: "main" }, body: { text: "Body text" } });
  });

  it("opens a merge request as a draft with uploaded attachments placed in the body", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pwragent-gitlab-attach-"));
    try {
      const image = path.join(dir, "after.png");
      writeFileSync(image, "png");
      const { client, writeCalls, uploads } = harness((endpoint) => endpoint === projectPath ? { default_branch: "main" } : [], (call) => call.endpoint.endsWith("/merge_requests") ? mr(12, { title: (call.body as { title: string }).title, draft: true }) : {});
      const result = await client.execute("create_pull_request", { title: "Fix tests", draft: true, body: `See ![After](${image})`, attachments: [{ path: image }], addLabels: ["bug", "ci"] }, ctx({ directories: [dir] }));
      expect(uploads).toEqual(["after.png"]);
      expect(writeCalls[0]).toEqual({ method: "POST", endpoint: `${projectPath}/merge_requests`, body: { source_branch: "topic", target_branch: "main", title: "Draft: Fix tests", description: "See ![After](/uploads/hash/after.png)", labels: "bug,ci" } });
      expect(result).toMatchObject({ created: true, pullRequest: { number: 12, draft: true }, url: "https://gitlab.example.test/group/sub/project/-/merge_requests/12" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("toggles draft through the title prefix", async () => {
    const { client, writeCalls } = harness(() => mr(3, { title: "Draft: Fix tests" }), () => mr(3, { title: "Fix tests" }));
    await client.execute("update_pull_request", { number: 3, draft: false, state: "closed" }, ctx());
    expect(writeCalls[0]).toMatchObject({ method: "PUT", endpoint: `${projectPath}/merge_requests/3`, body: { title: "Fix tests", state_event: "close" } });
  });

  it("merges only the checked head and refuses a method GitLab cannot do", async () => {
    const { client, writeCalls } = harness(() => ({}), () => { throw new GitLabReadError(409, undefined, "SHA does not match HEAD of source branch"); });
    await expect(client.execute("merge_pull_request", { number: 9, expectedHeadSha: "d".repeat(40) }, ctx())).rejects.toMatchObject({ code: "head_changed" });
    expect(writeCalls[0]).toMatchObject({ method: "PUT", body: { sha: "d".repeat(40), squash: true } });
    await expect(client.execute("merge_pull_request", { number: 9, expectedHeadSha: "d".repeat(40), method: "rebase" }, ctx())).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("returns GitLab's reason for a refused write", async () => {
    const { client } = harness(() => ({}), () => { throw new GitLabReadError(422, undefined, "Another open merge request already exists for this source branch: !4"); });
    await expect(client.execute("add_issue_comment", { number: 4, body: "x", kind: "pr" }, ctx())).rejects.toMatchObject({ code: "rejected", message: expect.stringContaining("already exists") });
  });

  it("maps resolvable discussions to review threads and replies by note id", async () => {
    const discussions = [
      { id: "d1", individual_note: false, notes: [{ id: 101, body: "Rename this.", author: { username: "rev" }, resolvable: true, resolved: false, position: { new_path: "src/a.ts", new_line: 4 } }] },
      { id: "d2", individual_note: true, notes: [{ id: 102, body: "General note", author: { username: "rev" }, resolvable: false }] },
    ];
    const { client, writeCalls } = harness((endpoint) => endpoint.includes("/discussions") ? discussions : [], () => ({ id: 201 }));
    const result = await client.execute("list_pull_request_review_threads", { number: 2 }, ctx()) as { threads: Array<Record<string, unknown>> };
    expect(result.threads).toEqual([expect.objectContaining({ reviewThreadId: "d1", path: "src/a.ts", line: 4, side: "RIGHT", isResolved: false })]);
    await client.execute("reply_to_review_comment", { number: 2, commentId: 101, body: "Done." }, ctx());
    expect(writeCalls[0]).toMatchObject({ method: "POST", endpoint: `${projectPath}/merge_requests/2/discussions/d1/notes`, body: { body: "Done." } });
  });

  it("needs the merge request number to resolve a thread", async () => {
    const { client, writeCalls } = harness(() => ({}), () => ({ notes: [{ resolvable: true, resolved: true }] }));
    await expect(client.execute("resolve_review_thread", { reviewThreadId: "d1", resolved: true }, ctx())).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(client.execute("resolve_review_thread", { reviewThreadId: "d1", resolved: true, number: 2 }, ctx())).resolves.toMatchObject({ isResolved: true });
    expect(writeCalls[0]).toMatchObject({ method: "PUT", endpoint: `${projectPath}/merge_requests/2/discussions/d1`, body: { resolved: true } });
  });

  it("posts inline comments at the head's diff refs, approves, and refuses request changes", async () => {
    const { client, writeCalls } = harness(() => mr(5), () => ({ notes: [{ id: 301 }] }));
    await client.execute("submit_pull_request_review", { number: 5, event: "APPROVE", comments: [{ path: "src/a.ts", line: 8, body: "Nit." }] }, ctx());
    expect(writeCalls.map((call) => call.endpoint)).toEqual([`${projectPath}/merge_requests/5/discussions`, `${projectPath}/merge_requests/5/approve`]);
    expect(writeCalls[0]!.body).toMatchObject({ position: { position_type: "text", head_sha: "a".repeat(40), base_sha: "b".repeat(40), new_path: "src/a.ts", new_line: 8 } });
    await expect(client.execute("submit_pull_request_review", { number: 5, event: "REQUEST_CHANGES", body: "No." }, ctx())).rejects.toMatchObject({ code: "unsupported_operation" });
  });

  it("falls back to paged diffs when raw_diffs is missing", async () => {
    const { client } = harness((endpoint) => {
      if (endpoint.endsWith("/raw_diffs")) throw new GitLabReadError(404);
      return endpoint.includes("page=1") ? [{ old_path: "src/a.ts", new_path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new\n" }] : [];
    });
    const result = await client.execute("get_pull_request_diff", { number: 6 }, ctx()) as { diff: { text: string }; files: number };
    expect(result.files).toBe(1);
    expect(result.diff.text).toBe("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n");
  });

  it("reads merge request comments with kind pr and omits system notes", async () => {
    const { client, readCalls } = harness(() => [{ id: 1, body: "Looks good", author: { username: "a" } }, { id: 2, body: "changed the description", system: true }]);
    const result = await client.execute("list_issue_comments", { number: 8, kind: "pr" }, ctx()) as { comments: unknown[] };
    expect(readCalls[0]).toContain(`${projectPath}/merge_requests/8/notes?`);
    expect(result.comments).toHaveLength(1);
  });
});

describe("GitLab write transport", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), "pwragent-glab-write-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sends the body through a private file, never in arguments, and reports GitLab's reason", async () => {
    let seenBody = "";
    const run = vi.fn(async (_command: string, args: string[]) => {
      seenBody = readFileSync(args[args.indexOf("--input") + 1]!, "utf8");
      if (args.includes("POST")) return "HTTP/2 201 Created\r\ncontent-type: application/json\r\n\r\n{\"iid\":4}";
      throw Object.assign(new Error("exit 1"), { stdout: "HTTP/2 422 Unprocessable Entity\r\n\r\n{\"message\":[\"Another open merge request already exists\"]}" });
    });
    const fetcher = new GitLabPrFetcher({ discover: async () => ({ selectedCommand: "glab-fixture", candidates: [], checkedAt: 0 }), run });
    await expect(fetcher.writeApi("gitlab.example.test", "projects/x/merge_requests", "POST", { title: "secret-title" })).resolves.toEqual({ iid: 4 });
    const args = run.mock.calls[0]![1];
    expect(args.slice(0, 6)).toEqual(["api", "--hostname", "gitlab.example.test", "--method", "POST", "--include"]);
    expect(args.join(" ")).not.toContain("secret-title");
    expect(JSON.parse(seenBody)).toEqual({ title: "secret-title" });
    await expect(fetcher.writeApi("gitlab.example.test", "projects/x/merge_requests/4", "PUT", {})).rejects.toMatchObject({ status: 422, reason: "Another open merge request already exists" });
  });

  it("uploads attachments with the glab token and returns GitLab's link", async () => {
    const file = path.join(root, "shot.png");
    writeFileSync(file, "png");
    const run = vi.fn(async (_command: string, args: string[]) => args[0] === "config" ? "glpat-fixture\n" : "");
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer glpat-fixture");
      expect(init?.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ url: "/uploads/abc/shot.png", markdown: "![shot](/uploads/abc/shot.png)" }), { status: 201 });
    });
    const fetcher = new GitLabPrFetcher({ discover: async () => ({ selectedCommand: "glab-fixture", candidates: [], checkedAt: 0 }), run, fetch: fetch as unknown as typeof globalThis.fetch });
    await expect(fetcher.uploadProjectFile("gitlab.example.test", "group/sub/project", { realPath: file, name: "shot.png" })).resolves.toEqual({ url: "/uploads/abc/shot.png" });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://gitlab.example.test/api/v4/projects/group%2Fsub%2Fproject/uploads");
  });
});

describe("placing uploaded attachments", () => {
  it("rewrites exact path references and appends the rest", () => {
    expect(placeUploadedAttachments("Before ![b](/tmp/b.png)", [
      { path: "/tmp/b.png", url: "/uploads/1/b.png", video: false },
      { path: "/tmp/a.png", alt: "After", url: "/uploads/2/a.png", video: false },
      { path: "/tmp/demo.mp4", url: "/uploads/3/demo.mp4", video: true },
    ])).toBe("Before ![b](/uploads/1/b.png)\n\n![After](/uploads/2/a.png)\n\n[demo.mp4](/uploads/3/demo.mp4)");
  });
});
