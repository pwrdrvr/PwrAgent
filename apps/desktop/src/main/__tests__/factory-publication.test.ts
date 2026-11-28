import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { factoryAdmissionSubject, type FactoryAdmissionRow } from "@pwragent/owner-core/factory-admission";
import type { FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { SqliteFactoryBranchReviewStore } from "@pwragent/sqlite-storage/factory-branch-review-store";
import { SqliteFactoryLandingStore } from "@pwragent/sqlite-storage/factory-landing-store";
import { ThreadDependencyStore } from "@pwragent/sqlite-storage/thread-dependency-store";
import { DEFAULT_PROJECT_FORGE_AUTOMATION } from "@pwragent/shared/project-forge-automation";
import { SqliteFactoryPublicationStore } from "@pwragent/sqlite-storage/factory-publication-store";
import { getProjectForgeAutomationIndex } from "../app-server/project-forge-automation-index";
import { createOwnerFactoryLanding } from "../factory/factory-landing";
import { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import { createThreadDependencyStorage } from "../storage/desktop-runtime-storage";
import { runGitCommand } from "../app-server/git-executable";
import { factoryBranchReviewId } from "../factory/factory-branch-review";
import { createOwnerFactoryPublication } from "../factory/factory-publication";
import { createOwnerFactoryScaling } from "../factory/factory-scaling-runtime";
import { handleOutpostCommand } from "../headless/outpost";
import { ForgeCiClient } from "../pr-status/forge-ci-client";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import {
  createFactoryAdmissionStorage, createFactoryBranchReviewStorage, createFactoryPublicationStorage, createFactoryLandingStorage,
} from "../storage/factory-admission-storage";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

vi.mock(import("../storage/factory-admission-storage"), () => ({
  createFactoryAdmissionStorage: vi.fn(), createFactoryBranchReviewStorage: vi.fn(), createFactoryPublicationStorage: vi.fn(), createFactoryLandingStorage: vi.fn(),
}));

vi.mock(import("../storage/desktop-runtime-storage"), async (original) => ({
  ...await original(), createThreadDependencyStorage: vi.fn(),
}));

afterEach(() => {
  getProjectForgeAutomationIndex().hydrate({});
  resetDesktopOverlayStoreForTests();
  vi.unstubAllEnvs();
});

type Services = Parameters<typeof handleOutpostCommand>[0];
const cli = path.resolve(import.meta.dirname, "../../../../../packages/pwragent/bin/pwragent.js");
const run = promisify(execFile);
const issueId = "00000000-0000-4000-8000-000000000262";
const repository = "pwrdrvr/synthetic";
const repositoryId = "R_factory";
const owner = { instanceId: "pwr_fixture", machineId: "mach_fixture" };
const branch = "factory/fixture";
const baseRef = "refs/remotes/origin/main";
const creation = { title: "Synthetic publication", body: "Reviewed branch preview", draft: true };
const policy = {
  risk: { level: "routine", reference: "Operator reviewed the patch and scope." },
  visual: { decision: "not_required", reference: "This change only adjusts an internal calculation." },
  acceptOperatorAttestedScaling: true,
};

async function fixture(workItem?: FactoryWorkItem, selectedBaseRef = baseRef) {
  const baseRef = selectedBaseRef;
  const root = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "fp-"));
  let db: StateDb | undefined;
  let server: net.Server | undefined;
  onTestFinished(async () => {
    if (server) await new Promise<void>((done) => server?.close(() => done()));
    db?.close();
    await rm(root, { recursive: true, force: true });
  });
  vi.stubEnv("PWRAGENT_HOME", root);
  vi.stubEnv("PWRAGENT_PROFILE", "t");
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const project = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  const dbPath = path.join(root, "factory.db");
  await mkdir(project);
  const localGit = async (cwd: string, args: string[]) => (await runGitCommand(cwd, args)).stdout.trim();
  const commit = (cwd: string, title: string) => localGit(cwd, [
    "-c", "user.name=Factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "--allow-empty", "-m", title,
  ]);
  await localGit(project, ["init", "--template=", "-b", "main"]);
  await commit(project, "base");
  const baseOid = await localGit(project, ["rev-parse", "HEAD"]);
  await localGit(project, ["worktree", "add", "-b", branch, worktree]);
  await writeFile(path.join(worktree, "candidate"), "fixture\n");
  await localGit(worktree, ["add", "candidate"]);
  await commit(worktree, "candidate");
  const headOid = await localGit(worktree, ["rev-parse", "HEAD"]);
  await localGit(project, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
  await localGit(project, ["update-ref", baseRef, baseOid]);
  const projectKey = `directory:${project}`;
  const selection = { branch, baseRef, headOid, baseOid };
  const approvalId = randomUUID();
  const subject = { approvalId, projectKey, repository, ...(workItem ? { workItem } : { issueId }) };
  const params = { ...subject, ...selection, policy, notReadyLabel: "hold-for-operator" };
  const pr = {
    id: "PR_fixture", number: 42, state: "OPEN", isDraft: true, headRefName: branch, headRefOid: headOid,
    baseRefName: "main", headRepository: { id: repositoryId }, baseRepository: { id: repositoryId },
    baseRef: { target: { oid: baseOid } }, labels: { nodes: [{ name: "hold-for-operator" }], pageInfo: { hasNextPage: false } },
  };
  const remote = {
    head: { target: { oid: headOid } } as { target: { oid: string } } | null,
    base: { target: { oid: baseOid } } as { target: { oid: string } } | null,
    pullRequests: [] as (typeof pr)[],
    unreadable: false,
  };
  const created = (entry: typeof pr) => ({
    node_id: entry.id, number: entry.number, state: "open", draft: entry.isDraft,
    head: { ref: entry.headRefName, sha: entry.headRefOid, repo: { node_id: entry.headRepository.id } },
    base: { ref: entry.baseRefName, sha: entry.baseRef.target.oid, repo: { node_id: entry.baseRepository.id } },
  });
  let beforeToken = () => {};
  let policyEnabled = true;
  let onCreate = async (): Promise<Response> => {
    remote.pullRequests = [pr];
    return Response.json(created(pr), { status: 201 });
  };
  const post = vi.fn<typeof fetch>(async (url, options) => {
    expect(url).toBe(`https://api.github.com/repos/${repository}/pulls`);
    expect(options).toMatchObject({ method: "POST", redirect: "manual", body: JSON.stringify({
      title: creation.title, head: branch, base: "main", body: creation.body, draft: creation.draft,
    }) });
    return onCreate();
  });
  const client = new ForgeCiClient({
    gitlab: { readApi: async () => { throw new Error("Unexpected GitLab request"); } },
    enabled: () => true, takeToken: () => true, fetch: post,
    githubToken: async () => { beforeToken(); return "synthetic-token"; },
  });
  const requestGithub = vi.fn<ForgeCiClient["requestGithub"]>(async (repo, request) => {
    expect(repo).toEqual({ host: "github.com", provider: "github", owner: "pwrdrvr", repo: "synthetic" });
    if (request.method === "POST") return client.requestGithub(repo, request);
    expect(request).toMatchObject({ graphql: true, path: "", body: { variables: {
      head: `refs/heads/${branch}`, base: "refs/heads/main",
    } } });
    const body = request.body as { query: string; variables: { number?: number } };
    expect(body.query).toMatch(/^query FactoryPublication/);
    expect(request.method).toBeUndefined();
    if (remote.unreadable) throw new Error("Lost provider reply");
    const number = body.variables.number;
    const selected = number ? { selected: remote.pullRequests.find((entry) => entry.number === number) ?? null }
      : { matches: { nodes: remote.pullRequests.slice(0, 2), pageInfo: { hasNextPage: remote.pullRequests.length > 2 } } };
    return { data: { repository: { id: repositoryId, nameWithOwner: repository, head: remote.head, base: remote.base, ...selected } } };
  });
  const requiredChecks = ["integration / test"];
  const integration = {
    oid: "c".repeat(40), parents: { nodes: [{ oid: baseOid }, { oid: headOid }] },
    statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{
      __typename: "CheckRun", id: "CR_integration", name: requiredChecks[0], status: "COMPLETED",
      conclusion: "SUCCESS", isRequired: true,
    }] } },
  };
  const live = {
    ...pr, isDraft: false, labels: { ...pr.labels, nodes: [] as typeof pr.labels.nodes },
    headRef: { target: { oid: headOid } } as typeof pr.baseRef | null,
    mergeQueueEntry: null as { id: string; state: string } | null,
    isMergeQueueEnabled: true, autoMergeRequest: null as { enabledAt: string } | null,
    timelineItems: { nodes: [] as { __typename: string; id: string; createdAt: string; reason?: string }[] },
    commits: { nodes: [{ commit: { oid: headOid, statusCheckRollup: { state: "SUCCESS" } } }] },
    potentialMergeCommit: integration as typeof integration | null,
  };
  const forge = {
    permission: "WRITE", repoId: repositoryId, unreadable: false, loseEnqueueReply: false, enabled: true,
    beforeStack: undefined as undefined | (() => Promise<void>),
    extraHistory: [] as unknown[],
  };
  const requestLanding = vi.fn<ForgeCiClient["requestGithub"]>(async (repo, request) => {
    expect(repo).toEqual({ host: "github.com", provider: "github", owner: "pwrdrvr", repo: "synthetic" });
    expect(request.body).toMatchObject({ query: expect.stringMatching(/^query FactoryLanding/),
      variables: { owner: "pwrdrvr", name: "synthetic", number: 42, id: pr.id } });
    if (forge.unreadable) throw new Error("Lost provider read");
    return { data: { viewer: { id: "U_operator", login: "operator" }, repository: {
      id: forge.repoId, nameWithOwner: repository, viewerPermission: forge.permission,
      pullRequest: { ...live, isInMergeQueue: Boolean(live.mergeQueueEntry) },
    } } };
  });
  const providerWrites = vi.fn<(head: string) => void>();
  const runGhCommand = vi.fn<(command: string, args: string[]) => Promise<{ stdout: string }>>(async (_command, args) => {
    if (args.includes(`repos/${repository}/pulls/42`)) {
      await forge.beforeStack?.();
      return { stdout: JSON.stringify({
        state: "open", number: 42, created_at: "2026-01-01T00:00:00Z",
        head: { sha: live.headRefOid, ref: branch, repo: { full_name: repository } },
        base: { ref: live.baseRefName, repo: { default_branch: "main" } },
      }) };
    }
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("PwrAgentStackHistory")) return { stdout: JSON.stringify({ data: { repository: { pullRequest: {
      baseRefName: live.baseRefName, headRefOid: live.headRefOid,
      timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: forge.extraHistory },
    } } } }) };
    expect(query).toContain("enqueuePullRequest");
    expect(args).toContain(`id=${pr.id}`);
    expect(args).toContain(`head=${headOid}`);
    providerWrites(headOid);
    live.mergeQueueEntry = { id: "MQ_fixture", state: "AWAITING_CHECKS" };
    if (forge.loseEnqueueReply) throw new Error("GitHub accepted the enqueue but did not reply");
    return { stdout: JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: {
      ...live.mergeQueueEntry, position: 1, enqueuedAt: new Date().toISOString(),
    } } } }) };
  });
  const fetcher = new GithubPrFetcher({
    discoverGhCommands: async () => ({ selectedCommand: "/fixture/gh" }) as never,
    runGhCommand,
  });
  const federation = {
    knownLocalInstanceId: () => owner.instanceId,
    factoryExecutorHost: () => owner,
  } as unknown as Parameters<typeof createOwnerFactoryPublication>[0]["federation"];
  let held = true;
  const options = { federation, leaseHeld: () => held, github: requestGithub,
    prepareCreatePolicy: async (threadId: string) => {
      expect(threadId).toBe("implementation");
      return () => { if (!policyEnabled) throw new Error("Pull requests are off for this project"); };
    },
  };
  let services: Services;
  let publication: SqliteFactoryPublicationStore;
  let review: SqliteFactoryBranchReviewStore;
  function open() {
    db?.close();
    db = StateDb.open(dbPath);
    const admission = new SqliteFactoryAdmissionStore(db);
    publication = new SqliteFactoryPublicationStore(db);
    review = new SqliteFactoryBranchReviewStore(db);
    const overlay = new SqliteOverlayStore(db);
    vi.mocked(createFactoryLandingStorage).mockReturnValue(new SqliteFactoryLandingStore(db));
    const dependencies = new ThreadDependencyStore(db.raw);
    vi.mocked(createThreadDependencyStorage).mockReturnValue(dependencies);
    vi.mocked(createFactoryAdmissionStorage).mockReturnValue(admission);
    vi.mocked(createFactoryBranchReviewStorage).mockReturnValue(review);
    vi.mocked(createFactoryPublicationStorage).mockReturnValue(publication);
    setDesktopOverlayStoreForTests(overlay);
    services = { factoryScaling: createOwnerFactoryScaling(options),
      factoryPublication: createOwnerFactoryPublication(options),
      factoryLanding: createOwnerFactoryLanding({
        ...options, github: requestLanding, githubEnabled: () => forge.enabled, fetcher,
      }),
    } as Services;
    return { admission, overlay, dependencies };
  }
  const { admission, overlay, dependencies } = open();
  await overlay.upsertDirectoryLaunchpad({
    directoryKey: projectKey, directoryKind: "directory", directoryLabel: "Synthetic", directoryPath: project,
    registeredAt: 1, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
  });
  const approved = {
    ...(workItem ? factoryAdmissionSubject(projectKey, workItem) : { projectKey, issueId }),
    id: approvalId, phase: "armed", repository, revision: 1, createdAt: 1,
    payloadHash: "fixture", owner, target: { ...owner, threadId: "implementation", worktreePath: worktree },
    platform: process.platform as FactoryAdmissionRow["platform"], requiresE2eVm: false,
  } satisfies FactoryAdmissionRow;
  expect(admission.insert(approved)).toBe(true);
  admission.update(approved, { ...approved, phase: "terminal", revision: 2, outcome: "completed", turnId: "implementation-turn" });

  let loseReply = false;
  if (process.platform !== "win32") {
    const socketDirectory = path.join(root, "profiles", "t", "state", "headless");
    await mkdir(socketDirectory, { recursive: true });
    const socketPath = path.join(socketDirectory, "rpc.sock");
    const listener = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let line = "";
      socket.on("data", (data: string) => {
        line += data;
        if (!line.endsWith("\n")) return;
        const message = JSON.parse(line) as { version: number; method: string; params: Record<string, unknown> };
        const drop = loseReply;
        loseReply = false;
        expect(message.version).toBe(1);
        void handleOutpostCommand(services, message.method, message.params).then(
          (result) => { if (drop) socket.destroy(); else socket.end(JSON.stringify({ result }) + "\n"); },
          (error: Error) => socket.end(JSON.stringify({ error: error.message }) + "\n"),
        );
      });
    });
    server = listener;
    await new Promise<void>((done, fail) => {
      listener.once("error", fail);
      listener.listen(socketPath, done);
    });
  }
  async function command<T = Record<string, unknown>>(method: string, input: Record<string, unknown>, drop = false, cliCall = false): Promise<T> {
    if (process.platform === "win32" || (!drop && !cliCall)) {
      const result = await handleOutpostCommand(services, method, input);
      if (drop) throw new Error("Daemon disconnected");
      return result as T;
    }
    const file = path.join(root, `request-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify(input));
    loseReply = drop;
    const { stdout } = await run(process.execPath, [cli, method, "--params-file", file], { cwd: project });
    return JSON.parse(stdout) as T;
  }
  return {
    approvalId, params, pr, remote, requestGithub, project, projectKey, worktree, localGit, post, commit, created,
    setBeforeToken(value: typeof beforeToken) { beforeToken = value; },
    setPolicy(value: boolean) { policyEnabled = value; },
    setCreate(value: typeof onCreate) { onCreate = value; },
    dependencies, forge, integration, live, providerWrites, requestLanding, runGhCommand,
    landing: <T = { status: string; planId: string; resetId: string }>(action: string, extra = {}) =>
      command<T>("factory-landing", { action, approvalId, ...extra }),
    directLanding: (action: string, extra = {}) => handleOutpostCommand(services, "factory-landing", { action, approvalId, ...extra }),
    requiredChecks,
    setLease(value: boolean) { held = value; },
    restart: open,
    row: () => publication.read(approvalId),
    publication: () => publication,
    async clearReview(revision = selection) {
      const id = factoryBranchReviewId(approvalId, revision);
      expect(review.claim({ id, approvalId, worktree: await realpath(worktree), runtimeId: "reviewer", mergeBaseOid: baseOid })).toBe(true);
      review.observe(id, "reviewer-thread", "review-turn", "clear");
    },
    prepare: (extra = {}, cliCall = false) => command<{ status: string; planId: string }>("factory-publication", { ...params, action: "prepare", ...extra }, false, cliCall),
    arm: (confirm: string, drop = false, extra = {}, cliCall = false) => command("factory-publication", { ...params, action: "arm", confirm, ...extra }, drop, cliCall),
    reconcile: () => command("factory-publication", { action: "reconcile", approvalId }),
    scaling: (exitCode?: number, previousReceiptId: string | null = null, expected = { headOid, baseOid }) => command<{
      status: string; receipt?: { receiptId: string; content: { source: string } };
    }>("factory-scaling", {
      projectKey, repository, approvalId, candidate: { ...(workItem ? { workItem } : { issueId }), branch, baseRef },
      ...(exitCode === undefined ? { action: "status" } : {
        action: "record", expected: { headOid: expected.headOid, baseOid: expected.baseOid }, previousReceiptId,
        report: { exitCode, counterexamples: [], workloads: [{
          name: "Bounded lookup", proof: "file:///factory/audit.json", samples: [16, 64].map((refs) => ({
            sizes: { refs }, counters: { requests: { measured: 1, bound: 1 } },
          })),
        }] },
      }),
    }),
  };
}

it("requires real revision receipts and reconciles an operator-opened PR after a lost arm reply", async () => {
  const h = await fixture();
  expect(await h.reconcile()).toMatchObject({ status: "not_armed" });
  expect(await h.prepare()).toMatchObject({ status: "blocked", reason: expect.stringContaining("branch review") });
  await h.clearReview();
  expect(await h.scaling()).toMatchObject({ status: "missing" });
  expect(await h.prepare()).toMatchObject({ status: "blocked", reason: expect.stringContaining("(missing)") });
  const failed = await h.scaling(2);
  expect(failed).toMatchObject({ status: "failed", receipt: { content: { source: "operator_attested" } } });
  expect(await h.prepare()).toMatchObject({ status: "blocked", reason: expect.stringContaining("(failed)") });
  const current = await h.scaling(0, failed.receipt?.receiptId);
  expect(current).toMatchObject({ status: "current", receipt: { content: { source: "operator_attested" } } });
  for (const rejected of [
    { ...policy, risk: { level: "high_consequence", reference: "Security boundary change" } },
    { ...policy, risk: { level: "unverified", reference: "Pending review" } },
    { ...policy, visual: { decision: "pending", reference: "Waiting for operator" } },
    { ...policy, acceptOperatorAttestedScaling: false },
  ]) {
    expect(await h.prepare({ policy: rejected })).toMatchObject({ status: "blocked" });
  }
  const prior = await h.prepare();
  expect(prior).toMatchObject({ status: "prepared", mode: "manual_open", plan: { scalingReceiptId: current.receipt?.receiptId } });
  expect(h.row()).toBeUndefined();
  await writeFile(path.join(h.worktree, "dirty"), "uncommitted");
  expect(await h.arm(prior.planId)).toMatchObject({ status: "stale" });
  await rm(path.join(h.worktree, "dirty"));
  await h.scaling(0, current.receipt?.receiptId);
  expect(await h.arm(prior.planId)).toMatchObject({ status: "stale" });
  const prepared = await h.prepare();
  expect(await h.arm("a".repeat(64))).toMatchObject({ status: "stale" });
  h.remote.base = { target: { oid: h.params.headOid } };
  expect(await h.arm(prepared.planId)).toMatchObject({ status: "stale" });
  h.remote.base = { target: { oid: h.params.baseOid } };

  const { writes } = await measureSqliteWrites(async () => {
    await expect(h.arm(prepared.planId, true)).rejects.toThrow("Daemon disconnected");
    h.restart();
    expect(await h.reconcile()).toMatchObject({ status: "missing", planId: prepared.planId });
    h.remote.unreadable = true;
    expect(await h.reconcile()).toMatchObject({ status: "uncertain", planId: prepared.planId });
    h.remote.unreadable = false;
    h.remote.pullRequests = [h.pr];
    expect(await h.reconcile()).toMatchObject({
      status: "published", mode: "manual_open", mergeAuthority: "operator_only", pullRequest: { number: 42, readiness: "draft" },
    });
    expect(await h.arm(prepared.planId)).toMatchObject({ status: "published", planId: prepared.planId });
  });
  expectSqliteWriteBudget({ scenario: "factory-publication-manual-reconcile",
    note: "One durable arm and one PR binding through missing, uncertain, restart and retry.", writes });

  h.remote.pullRequests = [{ ...h.pr, baseRefName: "release" }];
  expect(await h.reconcile()).toMatchObject({ status: "conflict", recordedPrNumber: 42 });
  h.remote.pullRequests = [{ ...h.pr, id: "other-pr" }];
  expect(await h.reconcile()).toMatchObject({ status: "conflict", recordedPrNumber: 42 });
  h.remote.head = null;
  expect(await h.reconcile()).toMatchObject({ status: "missing", recordedPrNumber: 42 });
  await h.localGit(h.project, ["update-ref", baseRef, h.params.headOid]);
  expect(await h.scaling()).toMatchObject({ status: "stale" });
  expect(await h.reconcile()).toMatchObject({ status: "stale", recordedPrNumber: 42 });
});

it.each(["draft", "not_ready_label"] as const)("reuses a tracked GitHub pull request with %s readiness", async (readiness) => {
  const h = await fixture({ provider: "github", kind: "pull_request", repositoryId, number: 42 });
  await h.clearReview();
  expect(await h.scaling(0)).toMatchObject({ status: "current", outcomeId: "github:pull_request:R_factory:42" });
  expect(await h.prepare()).toMatchObject({ status: "missing" });
  h.remote.pullRequests = [{ ...h.pr, isDraft: readiness === "draft" }];
  const prepared = await h.prepare();
  expect(prepared).toMatchObject({ status: "prepared", mode: "reuse", pullRequest: { readiness } });
  h.remote.pullRequests = [{ ...h.pr, headRepository: { id: "fork" } }];
  expect(await h.arm(prepared.planId)).toMatchObject({ status: "conflict" });
  h.remote.pullRequests = [{ ...h.pr, isDraft: readiness === "draft" }];
  h.requestGithub.mockClear();
  const { writes } = await measureSqliteWrites(async () => {
    const arms = await Promise.all([h.arm(prepared.planId), h.arm(prepared.planId)]);
    for (const result of arms) expect(result).toMatchObject({
      status: "published", mode: "reuse", mergeAuthority: "operator_only", pullRequest: { readiness, number: 42 },
    });
  });
  if (readiness === "draft") expectSqliteWriteBudget({ scenario: "factory-publication-reuse",
    note: "One durable adoption when two arm calls reuse a tracked pull request.", writes });
  expect(h.requestGithub.mock.calls.length).toBeLessThanOrEqual(3);
  expect(h.row()).toMatchObject({ prId: h.pr.id, prNumber: 42 });
  h.restart();
  expect(await h.reconcile()).toMatchObject({ status: "published", pullRequest: { readiness } });
  h.setLease(false);
  await expect(h.reconcile()).rejects.toThrow("this local owner");
});

it("opens exactly one drafted PR through the owner CLI after the operator confirms the non-atomic effect", async () => {
  const h = await fixture();
  await h.clearReview();
  await h.scaling(0);
  const prepared = await h.prepare({ creation }, true);
  expect(prepared).toMatchObject({ status: "prepared", mode: "open_pr", creation: {
    effect: "open_one_pull_request", precondition: "non_atomic_branch_names", consequence: expect.stringContaining("start CI"),
  } });
  expect(h.post).not.toHaveBeenCalled();
  expect(h.row()).toBeUndefined();
  expect(await h.arm(prepared.planId, false, { creation: { ...creation, title: "Different" } })).toMatchObject({ status: "stale" });
  h.setBeforeToken(() => h.setPolicy(false));
  expect(await h.arm(prepared.planId, false, { creation })).toMatchObject({ status: "blocked", reason: expect.stringContaining("off for this project") });
  expect(h.post).not.toHaveBeenCalled();
  expect(h.row()).toBeUndefined();
  h.setPolicy(true);
  h.setBeforeToken(() => {});

  const { writes } = await measureSqliteWrites(async () => {
    h.requestGithub.mockClear();
    expect(await h.arm(prepared.planId, false, { creation }, true)).toMatchObject({
      status: "published", mode: "open_pr", mergeAuthority: "operator_only", pullRequest: { id: h.pr.id, number: 42, readiness: "draft" },
    });
    expect(h.requestGithub.mock.calls.map(([, request]) => request.method ?? "GraphQL")).toEqual(["GraphQL", "POST", "GraphQL"]);
    h.restart();
    expect(await h.arm(prepared.planId, false, { creation })).toMatchObject({ status: "published" });
    h.remote.pullRequests = [{ ...h.pr, id: "other-pr" }];
    expect(await h.reconcile()).toMatchObject({ status: "conflict" });
    expect(h.post).toHaveBeenCalledOnce();
  });
  expectSqliteWriteBudget({ scenario: "factory-publication-create",
    note: "One durable claim and one immutable PR binding, with a zero-write replay after restart.", writes });
});

it("fences simultaneous callers and a lost POST reply until the exact PR appears after restart", async () => {
  const h = await fixture({ provider: "jira", siteId: "fixture", id: "42" });
  await h.clearReview();
  await h.scaling(0);
  const { planId } = await h.prepare({ creation });
  const entered = Promise.withResolvers<void>();
  const lose = Promise.withResolvers<Response>();
  h.setCreate(async () => { entered.resolve(); return lose.promise; });
  const { writes } = await measureSqliteWrites(async () => {
    const first = h.arm(planId, false, { creation });
    await entered.promise;
    try {
      expect(h.row()).toMatchObject({ planId, creationState: "pending", prId: null });
      const claimed = h.row()!;
      expect(h.publication().arm({ ...claimed, approvalId: randomUUID() })).toBe(false);
      expect(h.publication().arm({ ...claimed, approvalId: randomUUID(), creationState: "none", prId: h.pr.id, prNumber: h.pr.number })).toBe(false);
      expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "uncertain" });
      expect(await h.prepare({ creation, previousPlanId: planId })).toMatchObject({ status: "uncertain" });
    } finally {
      lose.reject(new Error("Lost POST reply"));
    }
    expect(await first).toMatchObject({ status: "uncertain" });
    h.restart();
    expect(await h.reconcile()).toMatchObject({ status: "uncertain" });
    expect(await h.prepare({ creation, previousPlanId: planId })).toMatchObject({ status: "uncertain" });
    h.remote.pullRequests = [h.pr];
    expect(await h.reconcile()).toMatchObject({ status: "published", outcomeId: "jira:fixture:42", pullRequest: { id: h.pr.id } });
    expect(h.post).toHaveBeenCalledOnce();
  });
  expectSqliteWriteBudget({ scenario: "factory-publication-create-recovery",
    note: "A lost reply uses one claim and one eventual PR binding across concurrency, retry, and restart.", writes });
});

it.each(["head", "base"] as const)("pins a PR opened during %s drift and re-arms with fresh receipts without another create", async (ref) => {
  const h = await fixture({ provider: "github", kind: "issue", repositoryId, number: 77 });
  await h.clearReview();
  const scaling = await h.scaling(0);
  const { planId } = await h.prepare({ creation });
  const dir = ref === "head" ? h.worktree : h.project;
  h.setCreate(async () => {
    await h.commit(dir, "Moved during create");
    const oid = await h.localGit(dir, ["rev-parse", "HEAD"]);
    const changed = ref === "head" ? { ...h.pr, headRefOid: oid } : { ...h.pr, baseRef: { target: { oid } } };
    if (ref === "base") await h.localGit(dir, ["update-ref", baseRef, oid]);
    h.remote[ref] = { target: { oid } };
    h.remote.pullRequests = [changed];
    return Response.json(h.created(changed), { status: 201 });
  });
  expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "stale" });
  expect(h.row()).toMatchObject({ creationState: "fenced", prId: h.pr.id, prNumber: h.pr.number });
  h.restart();
  expect(await h.reconcile()).toMatchObject({ status: "stale" });
  const revision = { branch, baseRef, headOid: h.remote.head!.target.oid, baseOid: h.remote.base!.target.oid };
  const extra = { ...revision, previousPlanId: planId, creation };
  expect(await h.prepare(extra)).toMatchObject({ status: "blocked", reason: expect.stringContaining("branch review") });
  await h.clearReview(revision);
  expect(await h.prepare(extra)).toMatchObject({ status: "stale", reason: expect.stringContaining("scaling") });
  await h.scaling(0, scaling.receipt?.receiptId, revision);
  const next = await h.prepare(extra);
  expect(next).toMatchObject({ status: "prepared", mode: "reuse" });
  expect(await h.arm(next.planId, false, extra)).toMatchObject({
    status: "published", mode: "reuse", outcomeId: "github:issue:R_factory:77", pullRequest: { id: h.pr.id },
  });
  expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "already_armed" });
  expect(h.post).toHaveBeenCalledOnce();
});

it("allows a new explicit plan after a definitive GitHub refusal and fresh absence check", async () => {
  const h = await fixture();
  await h.clearReview();
  await h.scaling(0);
  const { planId } = await h.prepare({ creation });
  h.setCreate(async () => Response.json({ message: "Repository rules require a different PR title" }, { status: 422 }));
  const { writes } = await measureSqliteWrites(async () => {
    expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "blocked", reason: expect.stringContaining("Repository rules") });
    h.restart();
    expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "blocked" });
    expect(h.row()).toMatchObject({ creationState: "refused" });
    expect(h.post).toHaveBeenCalledOnce();
  });
  expectSqliteWriteBudget({ scenario: "factory-publication-create-refusal",
    note: "One claim and one definitive refusal with a zero-write replay after restart.", writes });
  const extra = { creation, previousPlanId: planId };
  h.remote.pullRequests = [{ ...h.pr, headRepository: { id: "foreign" } }];
  expect(await h.prepare(extra)).toMatchObject({ status: "conflict" });
  h.remote.pullRequests = [];
  const next = await h.prepare(extra);
  expect(next).toMatchObject({ status: "prepared", mode: "open_pr" });
  expect(next.planId).not.toBe(planId);
  h.setCreate(async () => { h.remote.pullRequests = [h.pr]; return Response.json(h.created(h.pr), { status: 201 }); });
  expect(await h.arm(next.planId, false, extra)).toMatchObject({ status: "published" });
  expect(h.post).toHaveBeenCalledTimes(2);
});

it("refuses a moved preflight and reuses a PR that appeared after the opening preview", async () => {
  const h = await fixture();
  await h.clearReview();
  await h.scaling(0);
  const { planId } = await h.prepare({ creation });
  h.remote.head = { target: { oid: h.params.baseOid } };
  expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "stale" });
  h.remote.head = { target: { oid: h.params.headOid } };
  h.remote.pullRequests = [{ ...h.pr, isDraft: false }];
  expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "stale" });
  const reuse = await h.prepare({ creation });
  expect(reuse).toMatchObject({ status: "prepared", mode: "reuse", pullRequest: { readiness: "not_ready_label" } });
  expect(await h.arm(reuse.planId, false, { creation })).toMatchObject({ status: "published", mode: "reuse" });
  expect(h.post).not.toHaveBeenCalled();
});

async function publishedLanding() {
  const h = await fixture({ provider: "github", kind: "pull_request", repositoryId, number: 42 });
  await h.clearReview();
  expect(await h.scaling(0)).toMatchObject({ status: "current" });
  h.remote.pullRequests = [h.pr];
  const publication = await h.prepare();
  expect(await h.arm(publication.planId)).toMatchObject({ status: "published" });
  const checks = { requiredChecks: h.requiredChecks };
  return { ...h, checks,
    preview: () => h.landing("prepare", checks),
    enqueue: (confirm: string) => h.directLanding("enqueue", { ...checks, confirm }),
  };
}

it("admits only an explicitly confirmed PR through the operator queue, then reconciles and resets an acknowledged removal", async () => {
  const h = await publishedLanding();
  const { headOid, baseOid } = h.params;
  const { writes } = await measureSqliteWrites(async () => {
    const preview = await h.preview();
    expect(preview).toMatchObject({
      status: "prepared", mergeAuthority: "operator_only",
      workItem: { provider: "github", kind: "pull_request", repositoryId, number: 42 },
      pullRequest: { id: h.pr.id, number: 42, headOid, baseOid, base: "main", repositoryId },
      preview: { action: "enqueue", githubAccount: { login: "operator" }, ci: { candidateOid: h.integration.oid } },
    });
    expect(h.providerWrites).not.toHaveBeenCalled();
    expect(await h.landing("enqueue", { ...h.checks, confirm: preview.planId })).toMatchObject({ status: "queued" });
    expect(h.runGhCommand).toHaveBeenCalledTimes(3);
    expect(h.requestLanding).toHaveBeenCalledTimes(3);
    expect(await h.enqueue(preview.planId)).toMatchObject({ status: "queued" });
    expect(await h.directLanding("reset", { confirm: preview.planId })).toMatchObject({ status: "blocked" });
    h.live.mergeQueueEntry = null;
    h.live.timelineItems.nodes = [{
      id: "RM_fixture", __typename: "RemovedFromMergeQueueEvent", reason: "failed_checks", createdAt: new Date().toISOString(),
    }];
    h.restart();
    expect(await h.landing("reconcile")).toMatchObject({ status: "removed", attemptId: preview.planId });
    expect(await h.directLanding("reset", { confirm: preview.planId })).toMatchObject({ status: "ready" });
    expect(await h.enqueue(preview.planId)).toMatchObject({ status: "stale" });
    expect((await h.preview()).planId).not.toBe(preview.planId);
    expect(h.providerWrites).toHaveBeenCalledExactlyOnceWith(headOid);
  });
  expectSqliteWriteBudget({ scenario: "factory-landing-admit-and-reset",
    note: "One intent, one admission acknowledgment and one explicit reset. Preview, reconciliation and duplicates write nothing.", writes });
});

it("blocks drafts, hold labels, head-only or skipped CI, stale identity, project policy, and denied accounts", async () => {
  const h = await publishedLanding();
  const check = h.integration.statusCheckRollup.contexts.nodes[0]!;
  const index = getProjectForgeAutomationIndex();
  const good = await h.preview();
  expect(good.status).toBe("prepared");
  const contexts = h.integration.statusCheckRollup.contexts;
  for (const count of [16, 32, 64]) {
    contexts.nodes = [check, ...Array.from({ length: count - 1 }, (_, i) => ({ ...check, isRequired: false, name: `unrelated ${i}` }))];
    const before = h.requestLanding.mock.calls.length;
    expect(await h.directLanding("prepare", h.checks)).toMatchObject({ status: "prepared", planId: good.planId });
    expect(h.requestLanding.mock.calls.length - before).toBe(1);
  }
  contexts.nodes = [check];
  for (const [change, restore, status, reason] of [
    [() => { h.live.isDraft = true; }, () => { h.live.isDraft = false; }, "blocked", "ready for review"],
    [() => { h.live.labels.nodes = [{ name: "HOLD-FOR-OPERATOR" }]; }, () => { h.live.labels.nodes = []; }, "blocked", "hold label"],
    [() => { h.live.labels.pageInfo.hasNextPage = true; }, () => { h.live.labels.pageInfo.hasNextPage = false; }, "blocked", "incomplete label"],
    [() => { h.live.potentialMergeCommit = null; }, () => { h.live.potentialMergeCommit = h.integration; }, "blocked", "Head-only CI"],
    [() => { check.name = "other"; }, () => { check.name = h.requiredChecks[0]; }, "blocked", "MISSING"],
    [() => { check.isRequired = false; }, () => { check.isRequired = true; }, "blocked", "NOT_REQUIRED"],
    [() => { check.conclusion = "SKIPPED"; }, () => { check.conclusion = "SUCCESS"; }, "blocked", "SKIPPED"],
    [() => { h.live.baseRefName = "release"; }, () => { h.live.baseRefName = "main"; }, "stale", "target branch"],
    [() => { h.live.baseRef = { target: { oid: h.params.headOid } }; }, () => { h.live.baseRef = h.pr.baseRef; }, "stale", "target tip"],
    [() => { h.live.headRefOid = h.params.baseOid; }, () => { h.live.headRefOid = h.params.headOid; }, "stale", "head"],
    [() => { h.forge.repoId = "R_other"; }, () => { h.forge.repoId = repositoryId; }, "stale", "identity"],
    [() => { h.forge.permission = "READ"; }, () => { h.forge.permission = "WRITE"; }, "denied", "write access"],
    [() => { h.forge.enabled = false; }, () => { h.forge.enabled = true; }, "blocked", "disabled"],
    [() => { h.live.isMergeQueueEnabled = false; }, () => { h.live.isMergeQueueEnabled = true; }, "manual_required", "protected merge action"],
    [() => index.set(h.projectKey, { ...DEFAULT_PROJECT_FORGE_AUTOMATION, neverMerge: true }),
      () => index.set(h.projectKey, null), "blocked", "never merges"],
    [() => index.set(h.projectKey, { ...DEFAULT_PROJECT_FORGE_AUTOMATION, paused: true }),
      () => index.set(h.projectKey, null), "blocked", "Resume"],
  ] as const) {
    change();
    expect(await h.enqueue(good.planId)).toMatchObject({ status, reason: expect.stringContaining(reason) });
    restore();
  }
  h.dependencies.register({
    id: "hold", backend: "codex", threadId: "implementation", conditions: [{ backend: "codex", threadId: "prerequisite", when: "turn_completed" }],
    holdMerge: true, mode: "all", onFailure: "wait", evidence: [], status: "waiting", createdAt: 1, updatedAt: 1,
  });
  expect(await h.enqueue(good.planId)).toMatchObject({ status: "blocked", reason: expect.stringContaining("Merge held") });
  expect(h.providerWrites).not.toHaveBeenCalled();
});

it("fences competing and paused work during stack reads, and never replays an unknown provider reply", async () => {
  const h = await publishedLanding();
  const ready = await h.preview();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  h.forge.beforeStack = async () => { entered(); await gate; };
  const enqueue = h.enqueue(ready.planId);
  await waiting;
  expect(await h.enqueue(ready.planId)).toMatchObject({ status: "in_flight" });
  const controls = await measureSqliteWrites(async () => {
    expect(await h.directLanding("pause")).toMatchObject({ status: "paused" });
    release();
    expect(await enqueue).toMatchObject({ status: "stale" });
    expect(await h.directLanding("resume")).toMatchObject({ status: "ready" });
    const cancelled = await h.landing("cancel");
    expect(cancelled.status).toBe("cancelled");
    expect(await h.directLanding("resume")).toMatchObject({ status: "cancelled" });
    expect(await h.directLanding("reset", { confirm: cancelled.resetId })).toMatchObject({ status: "ready" });
  });
  expectSqliteWriteBudget({ scenario: "factory-landing-controls",
    note: "One commit per pause, resume, cancel and reset. A fenced dispatch and a cancelled resume write nothing.", writes: controls.writes });
  expect(await h.enqueue(ready.planId)).toMatchObject({ status: "stale" });
  const next = await h.preview();
  h.forge.beforeStack = async () => { h.live.commits.nodes[0]!.commit.statusCheckRollup.state = "PENDING"; };
  expect(await h.enqueue(next.planId)).toMatchObject({ status: "blocked", reason: expect.stringContaining("PENDING") });
  expect(h.providerWrites).not.toHaveBeenCalled();
  h.live.commits.nodes[0]!.commit.statusCheckRollup.state = "SUCCESS";
  h.forge.beforeStack = async () => { h.live.baseRef = { target: { oid: h.integration.oid } }; };
  expect(await h.enqueue(next.planId)).toMatchObject({ status: "stale", reason: expect.stringContaining("target tip") });
  expect(h.providerWrites).not.toHaveBeenCalled();
  h.live.baseRef = h.pr.baseRef;
  h.forge.beforeStack = undefined;
  h.forge.loseEnqueueReply = true;
  const { writes } = await measureSqliteWrites(async () => {
    expect(await h.enqueue(next.planId)).toMatchObject({ status: "uncertain", attemptId: next.planId });
    h.restart();
    h.forge.unreadable = true;
    expect(await h.enqueue(next.planId)).toMatchObject({ status: "uncertain" });
    h.forge.unreadable = false;
    expect(await h.landing("reconcile")).toMatchObject({ status: "queued" });
    h.live.mergeQueueEntry = null;
    expect(await h.enqueue(next.planId)).toMatchObject({ status: "uncertain" });
    h.live.timelineItems.nodes = [{
      id: "RM_fixture", __typename: "RemovedFromMergeQueueEvent", reason: "failed_checks", createdAt: new Date().toISOString(),
    }];
    expect(await h.directLanding("reset", { confirm: next.planId })).toMatchObject({ status: "blocked" });
    h.live.state = "CLOSED";
    expect(await h.landing("reconcile")).toMatchObject({ status: "closed" });
    h.live.state = "MERGED";
    h.live.baseRef = { target: { oid: h.integration.oid } };
    h.live.headRef = null;
    expect(await h.landing("reconcile")).toMatchObject({ status: "merged" });
    expect(h.providerWrites).toHaveBeenCalledTimes(1);
  });
  expectSqliteWriteBudget({ scenario: "factory-landing-unknown",
    note: "One durable intent for an unknown provider reply, with read-only recovery and duplicates.", writes });
});

it("keeps a mismatched creation response fenced from landing until explicit republication", async () => {
  const h = await fixture({ provider: "jira", siteId: "fixture", id: "42" });
  await h.clearReview();
  await h.scaling(0);
  const { planId } = await h.prepare({ creation });
  h.setCreate(async () => {
    h.remote.pullRequests = [h.pr];
    return Response.json(h.created({ ...h.pr, isDraft: !creation.draft }), { status: 201 });
  });
  expect(await h.arm(planId, false, { creation })).toMatchObject({ status: "stale" });
  h.restart();
  expect(await h.landing("prepare", { requiredChecks: h.requiredChecks })).toMatchObject({ status: "blocked" });
  expect(h.requestLanding).not.toHaveBeenCalled();
  const extra = { previousPlanId: planId };
  const next = await h.prepare(extra);
  expect(await h.arm(next.planId, false, extra)).toMatchObject({ status: "published" });
  const preview = await h.landing("prepare", { requiredChecks: h.requiredChecks });
  expect(preview.status).toBe("prepared");
  expect(await h.landing("enqueue", { requiredChecks: h.requiredChecks, confirm: preview.planId })).toMatchObject({ status: "queued" });
  expect(h.post).toHaveBeenCalledOnce();
  expect(h.providerWrites).toHaveBeenCalledOnce();
});

it("preserves queue reconciliation when a replacement publication races an uncertain admission", async () => {
  const h = await publishedLanding();
  const previousPlanId = h.row()!.planId;
  const extra = { previousPlanId };
  const replacement = await h.prepare(extra);
  const queue = await h.preview();
  h.forge.loseEnqueueReply = true;
  expect(await h.enqueue(queue.planId)).toMatchObject({ status: "uncertain" });
  h.restart();
  expect(await h.arm(replacement.planId, false, extra)).toMatchObject({ status: "conflict" });
  expect(await h.landing("reconcile")).toMatchObject({ status: "queued", publicationPlanId: previousPlanId });
  expect(h.providerWrites).toHaveBeenCalledOnce();
});

it("keeps an operator pause across republication and accepts replacement after explicit resume", async () => {
  const h = await publishedLanding();
  const queue = await h.preview();
  const extra = { previousPlanId: h.row()!.planId };
  const replacement = await h.prepare(extra);
  expect(await h.landing("pause")).toMatchObject({ status: "paused" });
  expect(await h.arm(replacement.planId, false, extra)).toMatchObject({ status: "conflict" });
  expect(await h.landing("resume")).toMatchObject({ status: "ready" });
  expect(await h.arm(replacement.planId, false, extra)).toMatchObject({ status: "published" });
  expect(await h.enqueue(queue.planId)).toMatchObject({ status: "stale" });
  const fresh = await h.preview();
  expect(fresh.status).toBe("prepared");
  expect(await h.enqueue(fresh.planId)).toMatchObject({ status: "queued" });
  expect(h.providerWrites).toHaveBeenCalledOnce();
});

it("opens the reviewed upstream target of a custom fetch mapping and fences same-OID remapping", async () => {
  const target = "refs/remotes/origin/review-target";
  const h = await fixture(undefined, target);
  await h.localGit(h.project, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:" + target]);
  await h.clearReview();
  await h.scaling(0);
  const prepared = await h.prepare({ creation });
  expect(prepared).toMatchObject({ status: "prepared", plan: { selection: { base: "main" } } });
  await h.localGit(h.project, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/release:" + target]);
  expect((await h.arm(prepared.planId, false, { creation })).status).not.toBe("published");
  expect(h.post).not.toHaveBeenCalled();
  await h.localGit(h.project, ["config", "--replace-all", "remote.origin.fetch", "+refs/heads/main:" + target]);
  expect(await h.arm(prepared.planId, false, { creation })).toMatchObject({ status: "published" });
  expect(h.post).toHaveBeenCalledOnce();
});

it("rechecks the clean worktree when GitHub's arm observation returns", async () => {
  const h = await fixture();
  await h.clearReview();
  await h.scaling(0);
  const prepared = await h.prepare({ creation });
  const original = h.requestGithub.getMockImplementation()!;
  h.requestGithub.mockImplementationOnce(async (...args) => {
    const response = await original(...args);
    await writeFile(path.join(h.worktree, "candidate"), "changed while observing GitHub");
    return response;
  });
  expect(await h.arm(prepared.planId, false, { creation })).toMatchObject({ status: "stale" });
  expect(h.post).not.toHaveBeenCalled();
});
