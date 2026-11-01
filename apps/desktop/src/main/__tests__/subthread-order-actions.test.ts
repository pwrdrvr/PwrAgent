import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFederatedThreadRef, buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const mocks = vi.hoisted(() => ({
  loadIndex: vi.fn(),
  publish: vi.fn(),
  store: undefined as SqliteOverlayStore | undefined,
}));
vi.mock("../app-server/navigation-query-source", () => ({ loadLocalNavigationQueryIndex: mocks.loadIndex }));
vi.mock("../app-server/desktop-overlay-store", () => ({ getDesktopOverlayStore: () => mocks.store }));
vi.mock("../app-server/backend-registry", () => ({
  getDesktopBackendRegistry: () => ({ publishLocalEvent: mocks.publish }),
}));
import { updateLocalSubthreadOrder } from "../app-server/subthread-order-actions";

let db: ReturnType<typeof openInMemoryStateDb>;

function summary(
  source: NavigationThreadSummary["source"],
  id: string,
  extra: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return { source, id, title: id, createdAt: 1, updatedAt: 1, linkedDirectories: [], ...extra } as NavigationThreadSummary;
}

beforeEach(() => {
  db = openInMemoryStateDb();
  mocks.store = new SqliteOverlayStore(db);
  mocks.publish.mockReset();
});
afterEach(() => db.close());

it("moves a Claude sub-thread under a Codex parent", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "design", parentThreadId: "root", parentThreadBackend: "codex" });
  // A legacy cross-provider link: only the parent id, resolved by unique id.
  await writeLegacyParentLink(mocks.store!, "claude", "legacy", "root");
  mocks.loadIndex.mockResolvedValue({ threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 3 }),
    summary("claude", "design", { parentThreadId: "root", parentThreadBackend: "codex", createdAt: 2 }),
    summary("claude", "legacy", { parentThreadId: "root", createdAt: 1 }),
    // Workers and federated rows never join the owner's order.
    summary("codex", "worker", { parentThreadId: "root", codexNativeSubAgent: {} } as unknown as Partial<NavigationThreadSummary>),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "legacy", anchorThreadId: "gondola", placement: "before" } });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["legacy", "gondola", "design"]);
  // The index is read for every provider in the group, not only the parent's.
  expect(mocks.loadIndex.mock.calls.map(([params]) => params.backend).sort()).toEqual(["claude", "codex"]);
  expect(mocks.publish).toHaveBeenCalledWith({ backend: "codex", notification: {
    method: "thread/subthreadOrder/updated", params: { parentThreadId: "root" } } });
});

it("refuses a legacy link whose parent id also names a thread on the child's own provider", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await writeLegacyParentLink(mocks.store!, "claude", "design", "root");
  mocks.loadIndex.mockResolvedValue({ threads: [
    summary("codex", "root"),
    summary("claude", "root"),
    summary("codex", "gondola", { parentThreadId: "root" }),
    summary("claude", "design", { parentThreadId: "root" }),
  ] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "design", anchorThreadId: "gondola", placement: "before" } })).rejects.toThrow("no longer places");
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("lists only the providers in the group, so an unrelated failing provider cannot block a move", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  // A Grok thread with its own unrelated group.
  await mocks.store!.setThreadParent({ backend: "acp:grok", threadId: "probe", parentThreadId: "elsewhere" });
  mocks.loadIndex.mockImplementation(async ({ backend }: { backend?: string }) => backend === "codex"
    ? { coverage: { state: "complete" }, threads: [
      summary("codex", "root"),
      summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
      summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
    ] }
    : { coverage: { state: "degraded", failedProviders: 1 }, threads: [] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "steam", anchorThreadId: "gondola", placement: "before" } });

  expect(mocks.loadIndex.mock.calls.map(([params]) => params.backend)).toEqual(["codex"]);
  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["steam", "gondola"]);
});

it("refuses a move while a provider with a child in the group is incompletely listed", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "design", parentThreadId: "root", parentThreadBackend: "codex" });
  mocks.loadIndex.mockImplementation(async ({ backend }: { backend?: string }) => backend === "codex"
    ? { coverage: { state: "complete" }, threads: [summary("codex", "root"),
      summary("codex", "gondola", { parentThreadId: "root" })] }
    : { coverage: { state: "degraded", failedProviders: 1 }, threads: [] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "gondola", anchorThreadId: "design", placement: "after" } })).rejects.toThrow("complete owner discovery");
  expect(mocks.publish).not.toHaveBeenCalled();
});

it("places a new Claude child below its Codex source before the owner lists it", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "claude", threadId: "fresh", parentThreadId: "root", parentThreadBackend: "codex" });
  mocks.loadIndex.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    insertAfter: { threadId: "fresh", sourceThreadId: "gondola" } });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["gondola", "fresh", "steam"]);
});

const LOCAL = "pwr_local";
const PEER = "pwr_peer";

/** A peer's thread whose link names this machine's `root` as its parent. */
async function pinPeerChild(threadId: string, extra: Partial<NavigationThreadSummary> = {}) {
  await mocks.store!.addRemoteThreadPin({
    ref: buildFederatedThreadRef({ backend: "codex", instanceId: PEER, threadId }),
    instanceLabel: "Win PC / dev",
    pinnedVia: "explicit",
    summary: summary("codex", threadId, { parentThreadId: "root", parentThreadBackend: "codex",
      parentThreadInstanceId: LOCAL, createdAt: 5, ...extra }),
  });
}

it("moves a peer's sub-thread among this machine's children of a local parent", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "steam", parentThreadId: "root" });
  await pinPeerChild("windows-e2e");
  // Another parent's peer child and one linked to a different machine stay out.
  await pinPeerChild("elsewhere", { parentThreadId: "other" });
  await pinPeerChild("foreign", { parentThreadInstanceId: "pwr_third" });
  mocks.loadIndex.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root", createdAt: 2 }),
    summary("codex", "steam", { parentThreadId: "root", createdAt: 1 }),
  ] });

  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "windows-e2e", anchorThreadId: "steam", placement: "before" } }, { resolveLocalInstanceId: async () => LOCAL });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["gondola", "windows-e2e", "steam"]);

  // A local move keeps the peer's child in the saved order.
  await updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "steam", anchorThreadId: "gondola", placement: "before" } }, { resolveLocalInstanceId: async () => LOCAL });

  expect((await mocks.store!.getThreadOverlayState({ backend: "codex", threadId: "root" }))?.subthreadOrder)
    .toEqual(["steam", "gondola", "windows-e2e"]);
});

it("refuses a peer's sub-thread when this machine has no federation identity", async () => {
  await mocks.store!.setThreadParent({ backend: "codex", threadId: "gondola", parentThreadId: "root" });
  await pinPeerChild("windows-e2e");
  mocks.loadIndex.mockResolvedValue({ coverage: { state: "complete" }, threads: [
    summary("codex", "root"),
    summary("codex", "gondola", { parentThreadId: "root" }),
  ] });

  await expect(updateLocalSubthreadOrder({ backend: "codex", parentThreadId: "root",
    move: { threadId: "windows-e2e", anchorThreadId: "gondola", placement: "before" } })).rejects.toThrow("no longer places");
});

/** Rows written before links recorded the parent's provider name only its id. */
async function writeLegacyParentLink(store: SqliteOverlayStore, backend: "claude", threadId: string, parentThreadId: string) {
  await store.setThreadParent({ backend, threadId, parentThreadId, parentThreadBackend: "codex" });
  const state = await store.getThreadOverlayState({ backend, threadId });
  (store as unknown as { putThread(key: string, state: object): void })
    .putThread(buildThreadIdentityKey(backend, threadId), { ...state, parentThreadBackend: undefined });
}
