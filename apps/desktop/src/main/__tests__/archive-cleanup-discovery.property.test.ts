import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { stat } from "node:fs/promises";
import type { AppServerThreadSummary, LinkedDirectorySummary, ThreadOverlayState } from "@pwragent/shared";
import type { ArchiveCleanupContext } from "../app-server/archive-cleanup-queue";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-cleanup-transport")).ArchiveCleanupTransport,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
vi.mock("../app-server/thread-assets", async (original) => ({
  ...await original<typeof import("../app-server/thread-assets")>(), deleteThreadAssets: async () => {},
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  stat: vi.fn(async () => { throw Object.assign(new Error("Removed fixture"), { code: "ENOENT" }); }),
}));

type Row = { id: string; cwd: string };
type Noise = { archived: boolean; claude: boolean; cwd: number };
type CleanupBoundary = {
  completeArchivedThreadCleanup(params: { backend: "codex"; threadId: string; archivedAt: number;
    codexRolloutMissing: boolean; messagingCleanup: {}; context: ArchiveCleanupContext }): Promise<{ cleanup: Array<{ removedWorktree: boolean }> }>;
  claudeBackend: { listThreads(params: { archived: boolean }): Promise<AppServerThreadSummary[]> };
};

const registries: DesktopBackendRegistry[] = [];
afterEach(async () => {
  await Promise.all(registries.splice(0).map((registry) => registry.close()));
  vi.mocked(stat).mockClear();
});

function worktree(cwd: string): LinkedDirectorySummary {
  return { id: cwd, kind: "worktree", label: "fixture", path: "/fixture/repository", worktreePath: cwd };
}

async function fixture(noise: Noise[], roots = 1, overlayOnly = false) {
  const candidates = Array.from({ length: roots }, (_, i) => `/fixture/candidate-${i}`);
  const effects = { git: 0, workspace: 0 };
  const inspected = new Set<string>();
  const overlays = new Map<string, ThreadOverlayState>();
  if (roots > 1 || overlayOnly) overlays.set("target", { backend: "codex", threadId: "target",
    extraLinkedDirectories: candidates.slice(overlayOnly ? 0 : 1).map(worktree) });
  const client = new CodexAppServerClient({ threadDirectoryEnricher: async (cwd) => {
    effects.git += 1;
    return { linkedDirectories: cwd && candidates.includes(cwd) ? [worktree(cwd)] : [] };
  } });
  await client.getInitializeResult();
  const transport = ArchiveCleanupTransport.latest;
  const rows: { active: Row[]; archived: Row[] } = { active: [], archived: [{ id: "target", cwd: overlayOnly ? "/fixture/primary" : candidates[0]! }] };
  const claude: { active: AppServerThreadSummary[]; archived: AppServerThreadSummary[] } = { active: [], archived: [] };
  noise.forEach((item, i) => {
    const row = { id: `noise-${i}`, cwd: `/fixture/unrelated-${item.cwd}` };
    const kind = item.archived ? "archived" : "active";
    if (item.claude) claude[kind].push({ id: row.id, source: "claude", title: row.id, titleSource: "explicit", projectKey: row.cwd, linkedDirectories: [] });
    else rows[kind].push(row);
  });
  transport.rows = rows;
  const readOverlays = async ({ backend, threadIds }: { backend: string; threadIds: string[] }) => {
    for (const id of threadIds) inspected.add(`${backend}:${id}`);
    return Object.fromEntries(threadIds.map((id) => [id, overlays.get(id)]));
  };
  const store = new Proxy({ getArchiveCleanupOverlayStates: readOverlays, getThreadOverlayStates: readOverlays,
    getThreadOverlayState: async ({ threadId }: { threadId: string }) => overlays.get(threadId),
  }, { get(object, key) {
    if (key === "then") return undefined;
    if (key in object) return object[key as keyof typeof object];
    return async () => String(key).startsWith("list") ? [] : undefined;
  } });
  let removed = 0;
  const archive = vi.fn(async (params: { backend: string; threadId: string; worktreePath: string; beforeRemove?: () => Promise<() => void> }) => {
    const guard = await params.beforeRemove!();
    guard();
    removed += 1;
    return { id: `snapshot-${removed}`, ...params, repositoryPath: "/fixture/repository", snapshotRef: "refs/codex/snapshots/test",
      snapshotCommit: "abc", createdAt: 1, archivedAt: 2, state: "archived", ignoredFilesExcluded: true };
  });
  const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: store as never,
    worktreeArchiveService: { archive } as never, threadTitleGenerationService: null,
    acpWorktreeRepositoryResolver: async () => { effects.workspace += 1; return undefined; },
  });
  registries.push(registry);
  const boundary = registry as unknown as CleanupBoundary;
  vi.spyOn(boundary.claudeBackend, "listThreads").mockImplementation(async ({ archived }) => claude[archived ? "archived" : "active"]);
  let checkpoints = 0;
  const context: ArchiveCleanupContext = { batch: {}, assertCurrent() {}, checkpoint: async () => { checkpoints += 1; }, settleCheckpoint: async () => {} };
  const cleanup = async () => await boundary.completeArchivedThreadCleanup({ backend: "codex", threadId: "target", archivedAt: 1,
    codexRolloutMissing: false, messagingCleanup: {}, context });
  return { registry, boundary, client, transport, rows, claude, overlays, effects, inspected, archive, context, cleanup,
    get removed() { return removed; }, get checkpoints() { return checkpoints; } };
}

async function measure(noise: Noise[], roots = 1, overlayOnly = false) {
  const run = await fixture(noise, roots, overlayOnly);
  try {
    const result = await run.cleanup();
    expect(result.cleanup.filter((item) => item.removedWorktree)).toHaveLength(roots);
    expect(run.inspected).toContain("codex:target");
    noise.forEach((item, i) => expect(run.inspected).toContain(`${item.claude ? "claude" : "codex"}:noise-${i}`));
    return { ...run.effects };
  } finally { await run.registry.close(); }
}

describe("single archive discovery isolation", () => {
  it("one disjoint archived cwd cannot add a Git discovery (shrunk regression)", async () => {
    expect(await measure([{ archived: true, claude: false, cwd: 0 }])).toEqual(await measure([]));
  });

  it("adding disjoint active/archived identities preserves the expensive-work bound", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ archived: fc.boolean(), claude: fc.boolean(), cwd: fc.integer({ min: 0, max: 110 }) }), { minLength: 1, maxLength: 120 }),
      fc.integer({ min: 1, max: 3 }), fc.boolean(),
      async (noise, roots, overlayOnly) => {
        expect(await measure(noise, roots, overlayOnly)).toEqual(await measure([], roots, overlayOnly));
      },
    ), { numRuns: 25 });
  });
});
