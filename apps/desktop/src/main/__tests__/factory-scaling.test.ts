import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FactoryAdmissionResult } from "@pwragent/owner-core/factory-admission";
import { SqliteFactoryAdmissionStore } from "@pwragent/sqlite-storage/factory-admission-store";
import { runGitCommand } from "../app-server/git-executable";
import { createOwnerFactoryAdmission } from "../factory/factory-admission-runtime";
import { createOwnerFactoryScaling } from "../factory/factory-scaling-runtime";
import { handleOutpostCommand } from "../headless/outpost";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createFactoryAdmissionStorage } from "../storage/factory-admission-storage";
import { resetDesktopOverlayStoreForTests, setDesktopOverlayStoreForTests } from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

vi.mock(import("../storage/factory-admission-storage"), () => ({ createFactoryAdmissionStorage: vi.fn() }));
vi.mock(import("../app-server/git-executable"), async (load) => {
  const actual = await load();
  return { ...actual, runGitCommand: vi.fn(actual.runGitCommand) };
});

const owner = { instanceId: "test-gateway", machineId: "mach_00000000-0000-4000-8000-000000000001" };
const other = { instanceId: "test-builder", machineId: "mach_00000000-0000-4000-8000-000000000002" };
const repository = "pwrdrvr/synthetic";
const candidate = {
  issueId: "00000000-0000-4000-8000-000000000262", branch: "factory/fixture", baseRef: "refs/remotes/origin/main",
};
const commit = ["-c", "user.name=Factory", "-c", "user.email=factory@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m"];
const proof = "file:///audit/probe.json";
const report = (largest = 16, exitCode = 0) => ({
  exitCode,
  workloads: [{ name: "Cold candidate read", proof, samples: [16, 32, 64].map((refs) => ({
    sizes: { refs }, counters: { gitStarts: { measured: refs === 64 ? largest : 16, bound: 16 } },
  })) }],
  counterexamples: largest > 16 ? [{ description: "The 64-ref case exceeded the Git start bound.", proof }] : [],
});
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  resetDesktopOverlayStoreForTests();
  for (const undo of cleanup.splice(0).reverse()) await undo();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

async function fixture(target = owner) {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const root = await mkdtemp(path.join(tmpdir(), "factory-scaling-"));
  vi.stubEnv("PWRAGENT_HOME", path.join(root, "home"));
  const project = path.join(root, "project");
  const worktree = path.join(root, "worktree");
  const { dbPath, tempDir } = createTempStateDb("factory-scaling-db-");
  let db = StateDb.open(dbPath);
  cleanup.push(async () => {
    db.close();
    removeTempStateDbDir(tempDir);
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(project);
  const git = async (cwd: string, args: string[]) => (await runGitCommand(cwd, args)).stdout.trim();
  await git(project, ["init", "--template=", "-b", "main"]);
  await writeFile(path.join(project, "tracked"), "base\n");
  await git(project, ["add", "tracked"]);
  await git(project, [...commit, "base"]);
  await git(project, ["worktree", "add", "-b", candidate.branch, worktree]);
  await git(worktree, [...commit, "head"]);
  const head = () => git(worktree, ["rev-parse", "HEAD"]);
  const base = () => git(project, ["rev-parse", "HEAD"]);
  const revision = { headOid: await head(), baseOid: await base() };
  await git(project, ["remote", "add", "origin", `https://github.com/${repository}.git`]);
  await git(project, ["update-ref", candidate.baseRef, revision.baseOid]);
  const projectKey = `directory:${project}`;
  const overlay = new SqliteOverlayStore(db);
  await overlay.upsertDirectoryLaunchpad({
    directoryKey: projectKey, directoryKind: "directory", directoryLabel: "Synthetic", directoryPath: project,
    registeredAt: 1, backend: "codex", executionMode: "default", workMode: "local", prompt: "", createdAt: 1, updatedAt: 1,
  });
  const local = { identity: owner, lease: true };
  type Runtime = Parameters<typeof createOwnerFactoryAdmission>[0];
  const options = {
    federation: {
      knownLocalInstanceId: () => local.identity.instanceId,
      factoryExecutorHost: () => local.identity,
    } as unknown as Runtime["federation"],
    leaseHeld: () => local.lease,
  };
  const open = () => {
    setDesktopOverlayStoreForTests(new SqliteOverlayStore(db));
    vi.mocked(createFactoryAdmissionStorage).mockReturnValue(new SqliteFactoryAdmissionStore(db));
    return createOwnerFactoryScaling(options);
  };
  let factoryScaling = open();
  const factoryAdmission = createOwnerFactoryAdmission({ ...options, checkouts: { factoryCpu: vi.fn() } as unknown as Runtime["checkouts"] });
  const approved = await handleOutpostCommand({ factoryAdmission } as Parameters<typeof handleOutpostCommand>[0], "factory-admission", {
    action: "arm", projectKey, issueId: candidate.issueId, owner, repository, platform: process.platform,
    target: { ...target, threadId: "test-thread", worktreePath: worktree }, brief: "Keep synthetic changes local.",
  }) as FactoryAdmissionResult;
  const params = { projectKey, repository, approvalId: approved.row.id, candidate };
  const run = (request: Record<string, unknown> = {}) => handleOutpostCommand(
    { factoryScaling } as Parameters<typeof handleOutpostCommand>[0], "factory-scaling", { ...params, action: "status", ...request },
  ) as ReturnType<ReturnType<typeof createOwnerFactoryScaling>>;
  return {
    local, project, worktree, git, revision, head, base, run,
    record: (evidence = report(), expected = revision, previousReceiptId: string | null = null) =>
      ({ action: "record", report: evidence, expected, previousReceiptId }),
    restart() {
      db.close();
      db = StateDb.open(dbPath);
      factoryScaling = open();
    },
  };
}

it("records a bounded local attestation and protects same-revision replacement from replay", async () => {
  const h = await fixture();
  const { writes } = await measureSqliteWrites(async () => {
    expect(await h.run()).toMatchObject({ status: "missing", candidate: { state: "clean", ...h.revision } });
    await expect(h.run(h.record({ ...report(), workloads: [] }))).rejects.toThrow();
    await expect(h.run({ ...h.record(), source: "independent" })).rejects.toThrow();
    await expect(h.run({ ...h.record(), approvalId: randomUUID() })).rejects.toThrow("exact Factory approval");
    await expect(h.run({ ...h.record(), repository: "other/synthetic" })).rejects.toThrow("exact Factory approval");
    await expect(h.run({ ...h.record(), candidate: { ...candidate, issueId: randomUUID() } })).rejects.toThrow("exact Factory approval");

    const failed = await h.run(h.record(report(17)));
    expect(failed).toMatchObject({ status: "failed", receipt: { content: {
      source: "operator_attested", revision: h.revision, report: report(17),
    } } });
    const previous = failed.receipt!.receiptId;
    const pathToReceipt = failed.receipt!.artifactPath;
    await utimes(pathToReceipt, 10, 10);
    h.restart();
    expect(await h.run(h.record(report(17)))).toEqual(failed);
    expect((await stat(pathToReceipt)).mtimeMs).toBe(10_000);
    // Even if two clean observations overlap, only one distinct replacement can use the same prior receipt.
    const replacements = await Promise.allSettled([
      h.run(h.record(report(), h.revision, previous)), h.run(h.record(report(15), h.revision, previous)),
    ]);
    expect(replacements.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("receipt changed") }) },
    ]);
    const current = await h.run();
    expect(current).toMatchObject({ status: "current", receipt: { content: { previousReceiptId: previous } } });
    expect(current.receipt?.receiptId).not.toBe(previous);
    await expect(h.run(h.record(report(17)))).rejects.toThrow("receipt changed");
    expect(await h.run()).toEqual(current);
    const counterexample = { ...report(), counterexamples: [{
      description: "A separate input repeats the same comparison for every pair.", proof: "file:///probe/pairs.json",
    }] };
    const adverse = await h.run(h.record(counterexample, h.revision, current.receipt!.receiptId));
    expect(adverse.status).toBe("failed");
    expect(await readdir(path.dirname(pathToReceipt))).toEqual([path.basename(pathToReceipt)]);
    expect((await stat(pathToReceipt)).size).toBeLessThanOrEqual(32_768);
  });
  expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0 });
});

it("invalidates a clean attestation on dirty files, moved refs and a different origin or owner", async () => {
  const h = await fixture();
  await h.run(h.record());
  const tracked = path.join(h.worktree, "tracked");
  await writeFile(path.join(h.worktree, "untracked"), "dirty");
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "dirty" } });
  await expect(h.run(h.record())).rejects.toThrow("must be clean");
  await rm(path.join(h.worktree, "untracked"));
  await h.git(h.worktree, ["update-index", "--assume-unchanged", "tracked"]);
  await writeFile(tracked, "hidden\n");
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "unverified" } });
  await h.git(h.worktree, ["update-index", "--no-assume-unchanged", "tracked"]);
  await h.git(h.worktree, ["restore", "tracked"]);
  // Git's rev-parse DWIM can resolve this tag in place of the selected full ref.
  await h.git(h.project, ["tag", candidate.baseRef, h.revision.baseOid]);
  await h.git(h.project, ["update-ref", "-d", candidate.baseRef]);
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "unverified" } });
  await h.git(h.project, [...commit, "integration advanced"]);
  const baseOid = await h.base();
  await h.git(h.project, ["update-ref", candidate.baseRef, baseOid]);
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "clean", headOid: h.revision.headOid, baseOid } });
  await expect(h.run(h.record())).rejects.toThrow("integration base");
  await h.git(h.worktree, [...commit, "head advanced"]);
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "clean", headOid: await h.head(), baseOid } });
  await h.git(h.project, ["remote", "set-url", "origin", "https://github.com/other/synthetic.git"]);
  expect(await h.run()).toMatchObject({ status: "stale", candidate: { state: "unverified" } });
  h.local.identity = { ...owner, machineId: other.machineId };
  await expect(h.run()).rejects.toThrow("selected local Federation owner");
  h.local.identity = other;
  await expect(h.run()).rejects.toThrow("selected local Federation owner");
  h.local.identity = owner;
  h.local.lease = false;
  await expect(h.run()).rejects.toThrow("selected local Federation owner");
});

it("will not reinterpret a remote executor path as the owner's checkout", async () => {
  const h = await fixture(other);
  await expect(h.run()).rejects.toThrow("approved worktree on the local owner");
});

it("holds candidate Git starts constant as tracked files and unrelated refs grow", async () => {
  const h = await fixture();
  const measuredGit = vi.mocked(runGitCommand);
  const samples = [[16, 16], [32, 16], [64, 16], [64, 32], [64, 64], [128, 128]];
  for (const [files, refs] of samples) {
    await Promise.all(Array.from({ length: files }, (_, i) => writeFile(path.join(h.worktree, `fixture-${i}`), "fixture\n")));
    await h.git(h.worktree, ["add", "."]);
    await h.git(h.worktree, [...commit, `track ${files} files`]);
    const headOid = await h.head();
    await runGitCommand(h.project, ["update-ref", "--stdin"], {
      input: Array.from({ length: refs }, (_, i) => `update refs/heads/unrelated/${i} ${headOid}\n`).join(""),
    });
    measuredGit.mockClear();
    expect(await h.run()).toMatchObject({ status: "missing", candidate: { state: "clean", headOid, baseOid: h.revision.baseOid } });
    expect(measuredGit).toHaveBeenCalledTimes(22);
    expect(measuredGit.mock.calls.filter(([, args]) => args[0] === "check-ref-format")).toHaveLength(4);
    expect(measuredGit.mock.calls.filter(([, args]) => args[0] === "config")).toHaveLength(2);
    expect(measuredGit.mock.calls.filter(([, args]) => args.includes("status"))).toHaveLength(1);
    expect(measuredGit.mock.calls.filter(([, args]) => args[0] === "ls-files")).toHaveLength(1);
  }
});
