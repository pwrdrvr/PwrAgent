import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { NavigationDetailService } from "../app-server/navigation-detail-service";
import * as desktopOverlayStore from "../storage/desktop-overlay-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import {
  applyNavigationSelectedDetail,
  navigationSelectionAuthorizesComposer,
  selectNavigationIdentity,
} from "../../renderer/src/lib/navigation-query-state";

vi.mock("../messaging/messaging-bindings-snapshot", () => ({
  buildMessagingBindingsByThreadKey: async () => undefined,
}));

async function checkDetail(scenario: { archived: boolean; archiveTimestamp: boolean; reads: boolean[] }) {
  const db = openInMemoryStateDb();
  const store = new SqliteOverlayStore(db);
  const storeRead = vi.spyOn(desktopOverlayStore, "getDesktopOverlayStore").mockReturnValue(store);
  const ref = { backend: "codex" as const, threadId: "cleanup-source" };
  let providerArchived = scenario.archived;
  const restoreThread = vi.fn(async () => { providerArchived = false; });
  const thread: AppServerThreadSummary = {
    id: ref.threadId, source: ref.backend, title: "Retained cleanup source", titleSource: "explicit",
    linkedDirectories: [], threadStatus: "notLoaded",
    ...(scenario.archived && scenario.archiveTimestamp ? { archivedAt: 123 } : {}),
  };
  // The provider's archive partition is the oracle, including when Codex
  // omits archivedAt. Cache warmup must not decide whether a link opens.
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      onNotification: () => () => {}, onPendingRequest: () => () => {},
      listThreads: async (params: { archived?: boolean }) =>
        (params.archived === true) === providerArchived ? [thread] : [],
      restoreThread,
      readConfiguredMcpServerNames: async () => [],
    } as never,
    overlayStore: store, threadTitleGenerationService: null,
  });
  try {
    for (const archived of scenario.reads) {
      await registry.listThreads({ backend: ref.backend, archived, enrichDirectories: false });
    }
    const service = new NavigationDetailService(registry);
    const detail = await service.readSelectedDetail({ protocol: 2, ref });
    expect(detail).toMatchObject({ identity: scenario.archived ? "archived" : "present", readiness: "ready", thread: {
      id: ref.threadId, title: thread.title,
    } });
    const selected = selectNavigationIdentity(undefined, ref);
    const state = applyNavigationSelectedDetail({ state: selected, sequence: selected.pendingSequence, detail });
    expect(navigationSelectionAuthorizesComposer(state)).toBe(!scenario.archived);
    const unchanged = await service.readSelectedDetail({ protocol: 2, ref, knownRevision: detail.revision });
    expect(unchanged).toMatchObject({ unchanged: true, identity: detail.identity });
    expect((await service.readSelectedDetail({ protocol: 2, ref: { ...ref, threadId: "missing" } })).identity)
      .toBe("unresolved");
    // Opening a read-only detail must preserve the provider's membership and
    // must not admit the archived destination through the active resolver.
    expect((await registry.resolveThread(ref))?.id).toBe(scenario.archived ? undefined : ref.threadId);
    expect(restoreThread).not.toHaveBeenCalled();

    // Archive membership can change without changing any configuration field
    // or timestamp. It must still invalidate the composer's authorization.
    providerArchived = !providerArchived;
    await registry.publishLocalEvent({ backend: ref.backend, notification: providerArchived
      ? { method: "thread/archived", params: { threadId: ref.threadId } }
      : { method: "thread/unarchived", params: { threadId: ref.threadId } },
    });
    const changed = await service.readSelectedDetail({ protocol: 2, ref, knownRevision: detail.revision });
    expect(changed.identity).toBe(providerArchived ? "archived" : "present");
    expect(changed.unchanged).not.toBe(true);
    expect(changed.thread?.id).toBe(ref.threadId);
    const refreshing = selectNavigationIdentity(state, ref);
    expect(navigationSelectionAuthorizesComposer(applyNavigationSelectedDetail({
      state: refreshing, sequence: refreshing.pendingSequence, detail: changed,
    }))).toBe(!providerArchived);
    expect(restoreThread).not.toHaveBeenCalled();
  } finally {
    await registry.close();
    storeRead.mockRestore();
    db.close();
  }
}

it("opens a cold archived cleanup source without authorizing its composer or restoring it", async () => {
  await checkDetail({ archived: true, archiveTimestamp: false, reads: [] });
});

it("opens existing thread details independently of archive membership, timestamps and list lookup order", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    archived: fc.boolean(), archiveTimestamp: fc.boolean(),
    reads: fc.array(fc.boolean(), { maxLength: 5 }),
  }), checkDetail), { numRuns: 25 });
});
