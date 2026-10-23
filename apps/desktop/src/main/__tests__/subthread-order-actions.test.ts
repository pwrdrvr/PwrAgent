import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared";
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
  // The index is read across providers, not only the parent's.
  expect(mocks.loadIndex).toHaveBeenCalledWith({ callerReason: "relative-child-move" });
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

/** Rows written before links recorded the parent's provider name only its id. */
async function writeLegacyParentLink(store: SqliteOverlayStore, backend: "claude", threadId: string, parentThreadId: string) {
  await store.setThreadParent({ backend, threadId, parentThreadId, parentThreadBackend: "codex" });
  const state = await store.getThreadOverlayState({ backend, threadId });
  (store as unknown as { putThread(key: string, state: object): void })
    .putThread(buildThreadIdentityKey(backend, threadId), { ...state, parentThreadBackend: undefined });
}
