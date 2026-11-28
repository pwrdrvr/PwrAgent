import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { handleOutpostCommand } from "../headless/outpost";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { SqliteFactoryBranchReviewStore } from "@pwragent/sqlite-storage/factory-branch-review-store";
import { factoryAdmissionSubject, type FactoryAdmissionRow } from "@pwragent/owner-core/factory-admission";
import type { FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import * as profile from "../profile";
import * as gitExecutable from "../app-server/git-executable";
import { createOwnerFactoryBranchReview } from "../factory/factory-branch-review-runtime";
import { getReviewAutoFixArming } from "../thread-reviews/review-auto-fix";
import { completedThreadReview } from "../thread-reviews/thread-review-events";
import { ThreadReviewService } from "../thread-reviews/thread-review-service";
import { measureSqliteWrites, resetSqliteWriteMetrics, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { createFactoryAdmissionStorage, createFactoryBranchReviewStorage } from "../storage/factory-admission-storage";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { SqliteThreadReviewStorage } from "../storage/thread-review-storage-sqlite";
import { createDeferred, git, MockBackendClient } from "./helpers/backend-registry-fixture";
import { factoryCli } from "./fixtures/factory-cli";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb, openFreshStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock(import("../storage/factory-admission-storage"), () => ({
  createFactoryAdmissionStorage: vi.fn(),
  createFactoryBranchReviewStorage: vi.fn(),
}));

afterEach(() => {
  resetDesktopOverlayStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const issueId = "521ed3a0-6f45-45fd-b8ec-fa070a530661";
const branch = "factory/fixture";
const baseRef = "refs/remotes/origin/main";
const parent = "implementation-thread";
const reviewer = "independent-review-thread";
const owner = { instanceId: "pwr_fixture", machineId: "mach_fixture" };
const structured = {
  findings: [], overall_correctness: "patch is correct", overall_explanation: "Reviewed the committed range.",
};
const finding = (file: string) => ({
  title: "Preserve the last frame", body: "The final frame is skipped.", confidence_score: 0.95, priority: 1,
  code_location: { absolute_file_path: file, line_range: { start: 1, end: 1 } },
});

async function fixture(workItem?: FactoryWorkItem) {
  const project = await mkdtemp(path.join(tmpdir(), "factory-review-"));
  onTestFinished(() => rm(project, { recursive: true, force: true }));
  const worktree = path.join(project, "implementation");
  const commit = async (cwd: string, name: string) =>
    git(cwd, ["-c", "user.name=Factory", "-c", "user.email=factory@example.invalid", "-c",
      "commit.gpgsign=false", "commit", "--allow-empty", "-m", name]);
  await git(project, ["init", "--template=", "-b", "main"]);
  await git(project, ["remote", "add", "origin", "https://github.com/pwrdrvr/fixture.git"]);
  await commit(project, "base");
  const baseOid = (await git(project, ["rev-parse", "HEAD"])).trim();
  await git(project, ["update-ref", baseRef, baseOid]);
  await git(project, ["worktree", "add", "-b", branch, worktree]);
  await writeFile(path.join(worktree, "candidate.txt"), "committed candidate\n");
  await git(worktree, ["add", "candidate.txt"]);
  await commit(worktree, "implementation");
  const headOid = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const projectKey = `directory:${project}`;
  const request = { projectKey, ...(workItem ? { workItem } : { issueId }), branch, baseRef, baseOid, headOid };
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const state = createTempStateDb("factory-branch-review-db-");
  let db = openFreshStateDb(state.dbPath);
  let registry: ReturnType<typeof createDesktopBackendRegistry> | undefined;
  onTestFinished(async () => {
    await registry?.close();
    db.close();
    removeTempStateDbDir(state.tempDir);
  });
  const target = { ...owner, threadId: parent, worktreePath: worktree };
  const admission = new SqliteFactoryAdmissionStore(db);
  const armed: FactoryAdmissionRow = {
    ...(workItem ? factoryAdmissionSubject(projectKey, workItem) : { projectKey, issueId }),
    id: "admission-1", createdAt: 1, phase: "armed", revision: 1,
    owner, target, repository: "pwrdrvr/fixture", platform: "darwin", requiresE2eVm: false, payloadHash: "fixture",
  };
  expect(admission.insert(armed)).toBe(true);
  const approve = () => admission.update(armed, {
    ...armed, phase: "terminal", outcome: "completed", turnId: "implementation-turn", revision: 2,
  });
  const runtimeIdentity = vi.spyOn(profile, "getProcessRuntimeIdentity");
  let generation = 0;
  const overlay = new SqliteOverlayStore(db);
  await overlay.upsertDirectoryLaunchpad({
    directoryKey: request.projectKey, directoryKind: "directory", directoryLabel: "Fixture", directoryPath: project,
    registeredAt: 1, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
  });
  const threadState = vi.fn(async () => ({
    threadStatus: "idle",
    thread: {
      id: parent, source: "codex", linkedDirectories: [{ kind: "worktree", path: project, worktreePath: worktree }],
    },
  }));
  const federation = {
    knownLocalInstanceId: () => owner.instanceId,
    factoryExecutorHost: () => owner,
    localBackend: () => ({ resolveThreadAdmissionState: threadState }),
  } as unknown as Parameters<typeof createOwnerFactoryBranchReview>[1];
  const createOwner = (options?: ConstructorParameters<typeof MockBackendClient>[0]) => {
    const client = new MockBackendClient({
      initializeResult: { methods: ["thread/start", "turn/start"] },
      startThreadResult: { threadId: reviewer }, ...options,
    });
    vi.spyOn(client, "readConfiguredMcpServerNames").mockResolvedValue(["publisher"]);
    const ownerRegistry = createDesktopBackendRegistry({ codexClient: client, overlayStore: new SqliteOverlayStore(db) });
    registry = ownerRegistry;
    const reviews = new ThreadReviewService(new SqliteThreadReviewStorage(db));
    ownerRegistry.onEvent((event) => {
      const result = completedThreadReview(event);
      if (result) reviews.importEntry(result.identity, result.entry, "live");
    });
    vi.mocked(createFactoryAdmissionStorage).mockReturnValue(new SqliteFactoryAdmissionStore(db));
    const store = new SqliteFactoryBranchReviewStore(db);
    vi.mocked(createFactoryBranchReviewStorage).mockReturnValue(store);
    runtimeIdentity.mockReturnValue({ instanceId: `review-owner-${++generation}`, startedAt: Date.now() });
    setDesktopOverlayStoreForTests(new SqliteOverlayStore(db));
    return { client, reviews, ownerRegistry, store, service: createOwnerFactoryBranchReview(ownerRegistry, federation, () => true) };
  };
  let runtime = createOwner();
  const command = (action: string, fields = {}) => handleOutpostCommand(
    { factoryBranchReview: runtime.service } as unknown as Parameters<typeof handleOutpostCommand>[0],
    "factory-review", { ...request, action, ...fields },
  ) as ReturnType<typeof runtime.service.command>;
  return {
    project, worktree, request, commit, command, approve, threadState,
    get client() { return runtime.client; },
    get reviews() { return runtime.reviews; },
    get registry() { return runtime.ownerRegistry; },
    get store() { return runtime.store; },
    async restart(options?: ConstructorParameters<typeof MockBackendClient>[0]) {
      await runtime.ownerRegistry.close();
      db.close();
      db = openFreshStateDb(state.dbPath);
      runtime = createOwner(options);
    },
    async finish(turnId: string, output?: string, method: "turn/completed" | "turn/failed" = "turn/completed") {
      const client = runtime.client;
      if (output) await client.emit({ method: "item/completed", params: {
        threadId: reviewer, turnId, item: { id: "review-output", type: "agentMessage", text: output },
      } });
      if (method === "turn/failed") {
        await client.emit({ method, params: { threadId: reviewer, turnId,
          turn: { id: turnId, status: "failed", error: { message: "Reviewer failed" } } } });
      } else {
        await client.emit({ method, params: { threadId: reviewer, turnId,
          turn: { id: turnId, status: "completed", output: [] } } });
      }
    },
  };
}

it("reviews a Jira-tracked GitHub branch through the CLI and isolates other sites", async () => {
  const workItem = { provider: "jira", siteId: "fixture-cloud", id: "12345" } as const;
  const h = await fixture(workItem);
  h.approve();
  const run = await factoryCli("factory-review", ({ action, ...fields }) => h.command(String(action), fields));
  await expect(run({ ...h.request, action: "start", workItem: { ...workItem, siteId: "other-cloud" } }))
    .rejects.toThrow("completed Factory implementation");
  const started = await run({ ...h.request, action: "start" });
  expect(started).toMatchObject({ workItem, status: "started", publication: "unobserved" });
  expect(started.issueId).toBeUndefined();
  expect(started.turnId).toBeDefined();
  expect(await run({ ...h.request, action: "start" })).toMatchObject({ id: started.id, turnId: started.turnId });
  await h.finish(started.turnId!, JSON.stringify(structured));
  expect(await run({ ...h.request, action: "status" })).toMatchObject({ id: started.id, status: "clear" });
});

// Git supplies the exact committed range and the worktree. The owner supplies
// approval and provider observations. Mutable refs and retries cannot replace either.
it("requires the approved, clean exact head and runs the genuine managed review read-only", async () => {
  const h = await fixture();
  await expect(h.command("start")).rejects.toThrow("completed Factory implementation");
  h.approve();
  await expect(h.command("start", { issueId: "PWR-262" })).rejects.toThrow();
  await expect(h.command("start", { headOid: h.request.baseOid })).rejects.toThrow("exact committed range");
  await writeFile(path.join(h.worktree, "dirty.txt"), "uncommitted");
  await expect(h.command("start")).rejects.toThrow("clean committed worktree");
  await rm(path.join(h.worktree, "dirty.txt"));
  await git(h.worktree, ["update-index", "--assume-unchanged", "candidate.txt"]);
  await expect(h.command("start")).rejects.toThrow("clean committed worktree");
  await git(h.worktree, ["update-index", "--no-assume-unchanged", "candidate.txt"]);
  await git(h.project, ["remote", "set-url", "origin", "https://github.com/another/fixture.git"]);
  await expect(h.command("start")).rejects.toThrow("origin does not match");
  await git(h.project, ["remote", "set-url", "origin", "https://github.com/pwrdrvr/fixture.git"]);

  const measured = await measureSqliteWrites(async () => {
    const response = await h.command("start");
    expect(response).toMatchObject({ status: "started", headOid: h.request.headOid, mergeBaseOid: h.request.baseOid,
      approvalId: "admission-1", implementationTurnId: "implementation-turn", reviewerThreadId: reviewer, turnId: "turn-1" });
    await h.finish("turn-1", JSON.stringify(structured));
    return h.command("status");
  });
  expect(h.client.lastStartThreadParams).toMatchObject({ sandbox: "read-only", approvalPolicy: "never", ephemeral: true,
    config: { mcp_servers: { publisher: { enabled: false } }, web_search: "disabled", features: { hooks: false } } });
  expect(h.client.lastStartTurnParams).toMatchObject({
    sandbox: "read-only", approvalPolicy: "never", threadId: reviewer,
    input: [expect.objectContaining({ text: expect.stringContaining(`diff --no-ext-diff --no-textconv ${h.request.baseOid} ${h.request.headOid}`) })],
  });
  expect(measured.result).toMatchObject({ status: "clear", stage: "branch", publication: "unobserved",
    acceptance: { humanVisual: "unverified", scaling: "unverified" },
    reference: expect.stringContaining("messageId=managed-review%3Aturn-1%3Aresult") });
  expectSqliteWriteBudget({
    scenario: "factory-branch-review-complete", note: "Launch one pinned managed review and publish its existing card plus the Factory receipt.",
    writes: measured.writes,
  });
  expect(measured.writes.tables.find((table) => table.table === "factory_branch_reviews")?.rowsChanged).toBe(3);
  await h.commit(h.worktree, "new candidate");
  expect(await h.command("status")).toMatchObject({ status: "stale", recordedResult: "clear" });
});

it("tracks open findings, leaves auto-fix unarmed, and preserves a parked branch", async () => {
  const h = await fixture();
  h.approve();
  await h.command("start");
  await h.finish("turn-1", JSON.stringify({ ...structured, findings: [finding(path.join(h.worktree, "candidate.txt"))] }));
  const findings = h.reviews.list({ backend: "codex", threadId: parent });
  expect(findings[0]).toMatchObject({ origin: "automatic", status: "open", context: { headCommit: h.request.headOid },
    items: [expect.objectContaining({ status: "open" })] });
  expect(getReviewAutoFixArming().takeOnCompletion({ backend: "codex", threadId: parent }, "turn-1")).toBe(false);
  await git(h.worktree, ["checkout", "--detach", h.request.baseOid]);
  await h.restart();
  expect(await h.command("status")).toMatchObject({
    issueId, status: "findings", stage: "parked", publication: "unobserved", observedHeadOid: h.request.headOid,
  });
  expect(await h.command("start")).toMatchObject({ status: "findings" });
  expect(h.client.startTurnCallCount).toBe(0);
  expect((await git(h.project, ["rev-parse", `refs/heads/${branch}`])).trim()).toBe(h.request.headOid);
});

it.each([
  ["inconclusive", JSON.stringify({ ...structured, overall_correctness: "I could not review the patch" })],
  ["inconclusive", JSON.stringify({ ...structured, findings: [{ title: "Malformed finding" }] })],
  ["failed", undefined],
] as const)("persists a %s outcome and never infers correctness", async (status, output) => {
  const h = await fixture();
  h.approve();
  await h.command("start");
  await h.finish("turn-1", output, status === "failed" ? "turn/failed" : "turn/completed");
  expect(await h.command("status")).toMatchObject({ status });
});

it("refuses an ambiguous verdict submitted through the managed reviewer ledger", async () => {
  const h = await fixture();
  h.approve();
  await h.command("start");
  const ledger = registryModules(h.registry).managedReviewService.candidateLedger;
  const submitted = ledger.submitOutput({ backend: "codex", threadId: reviewer, turnId: "turn-1" },
    { ...structured, overall_correctness: "The committed range was unavailable" });
  expect(submitted).toMatchObject({ ok: false, code: "invalid_arguments" });
  await h.finish("turn-1");
  expect(await h.command("status")).toMatchObject({ status: "inconclusive" });
});

it("reuses a single attempt on overlapping requests, a lost owner reply, and restart", async () => {
  const h = await fixture();
  h.approve();
  const start = h.registry.startPinnedManagedBranchReview.bind(h.registry);
  const issued = vi.spyOn(h.registry, "startPinnedManagedBranchReview");
  const hold = createDeferred<void>();
  const accepted = createDeferred<void>();
  issued.mockImplementationOnce(async (...params) => {
    await start(...params);
    accepted.resolve();
    await hold.promise;
    throw new Error("Lost caller acknowledgement");
  });
  const first = h.command("start");
  await accepted.promise;
  try {
    const duplicate = await h.command("start");
    expect(duplicate).toMatchObject({ status: "started", turnId: "turn-1" });
    await h.finish("turn-1", JSON.stringify(structured));
  } finally {
    hold.resolve();
  }
  const result = await first;
  expect(result.status).toBe("clear");
  expect(issued).toHaveBeenCalledTimes(1);
  await h.restart();
  expect(await h.command("start")).toEqual(result);
  expect(h.client.startTurnCallCount).toBe(0);
});

it("keeps an unacknowledged provider start fenced across a restart and a new head", async () => {
  const h = await fixture();
  h.approve();
  await h.restart({ startTurnError: new Error("Lost provider acknowledgement") });
  const result = await h.command("start");
  expect(result).toMatchObject({ status: "uncertain", turnId: undefined });
  expect(h.client.startTurnCallCount).toBe(1);
  await h.restart();
  expect(await h.command("status")).toEqual(result);
  expect(await h.command("start")).toEqual(result);
  await h.commit(h.worktree, "another candidate");
  const headOid = (await git(h.worktree, ["rev-parse", "HEAD"])).trim();
  expect(await h.command("status")).toMatchObject({ status: "stale", observedHeadOid: headOid });
  await expect(h.command("start", { headOid })).rejects.toThrow("running or uncertain branch review");
  expect(h.client.startTurnCallCount).toBe(0);
});

it("recovers exact completion from the existing durable artifact when the terminal receipt write was lost", async () => {
  const h = await fixture();
  h.approve();
  await h.command("start");
  vi.spyOn(h.store, "observe").mockImplementationOnce(() => { throw new Error("Lost receipt write"); });
  await h.finish("turn-1", JSON.stringify(structured));
  expect(await h.command("status")).toMatchObject({ status: "started", turnId: "turn-1" });
  await h.restart();
  resetSqliteWriteMetrics();
  const recovered = await measureSqliteWrites(() => h.command("start"));
  expect(recovered.result).toMatchObject({ status: "clear", turnId: "turn-1" });
  expect(h.client.startTurnCallCount).toBe(0);
  expectSqliteWriteBudget({
    scenario: "factory-branch-review-recovery", note: "Record one terminal verdict from the matching durable managed artifact after restart.",
    writes: recovered.writes,
  });
});

it("refuses a moved target during child setup before a review turn can start", async () => {
  const h = await fixture();
  h.approve();
  const startThread = h.client.startThread.bind(h.client);
  vi.spyOn(h.client, "startThread").mockImplementationOnce(async (params) => {
    await git(h.project, ["update-ref", baseRef, h.request.headOid]);
    return startThread(params);
  });
  expect(await h.command("start")).toMatchObject({ status: "stale", recordedResult: "refused" });
  expect(h.client.startTurnCallCount).toBe(0);
});

it("counts constant Git work and zero writes for status across unrelated refs", async () => {
  const h = await fixture();
  h.approve();
  await h.command("start");
  await h.finish("turn-1", JSON.stringify(structured));
  const gitCalls = vi.spyOn(gitExecutable, "runGitCommand");
  const counts: number[] = [];
  const { writes } = await measureSqliteWrites(async () => {
    for (const refs of [128, 256, 512]) {
      await writeFile(path.join(h.project, ".git", "packed-refs"), Array.from({ length: refs }, (_, index) =>
        `${h.request.baseOid} refs/heads/unrelated/${String(index).padStart(4, "0")}
`).join(""));
      gitCalls.mockClear();
      expect(await h.command("status")).toMatchObject({ status: "clear" });
      expect(gitCalls.mock.calls.filter(([, args]) => args[0] === "check-ref-format")).toHaveLength(2);
      expect(gitCalls.mock.calls.filter(([, args]) => args[0] === "config")).toHaveLength(1);
      counts.push(gitCalls.mock.calls.length);
    }
  });
  expect(counts).toEqual([11, 11, 11]);
  expect(h.threadState).toHaveBeenCalledTimes(1);
  expectSqliteWriteBudget({
    scenario: "factory-branch-review-status", note: "Read the exact persisted review at three ref counts with no writes.",
    writes,
  });
});
