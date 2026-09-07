import { describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationSnapshot } from "@pwragent/shared";
import { navigationOwnerApiFixture } from "../../test/navigation-owner-api-fixture";

const population = (): NavigationSnapshot => ({ backend: "all", fetchedAt: 1, unchanged: false,
  threads: [{ id: "one", source: "codex", title: "Before", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true } }],
  directories: [], inboxThreadKeys: ["codex:one"], launchpadDefaults: { backend: "codex", executionMode: "default" } });

describe("V2 owner fixture authority", () => {
  it("preserves a canonical owner event across an unchanged private population marker", async () => {
    let emit!: (event: AgentEvent) => void;
    const api = navigationOwnerApiFixture({ readPopulation: vi.fn().mockResolvedValueOnce(population())
      .mockResolvedValue({ ...population(), unchanged: true, threads: [] }),
      onAgentEvent: (listener) => { emit = listener; return () => undefined; } });
    api.onAgentEvent?.(() => undefined);
    await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } });
    emit({ backend: "codex", notification: { method: "thread/name/updated", params: { threadId: "one", threadName: "After" } } });
    await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", query: { kind: "directory-index" } });
    const detail = await api.getNavigationSelectedDetail!({ protocol: 2, ref: { backend: "codex", threadId: "one" } });
    expect(detail.thread?.title).toBe("After");
    await expect(api.getNavigationSnapshot?.({})).rejects.toThrow("forbidden");
  });

  it("keeps a confirmed archive out of owner counts when the private provider population is stale", async () => {
    const api = navigationOwnerApiFixture({ readPopulation: async () => population(),
      archiveThread: async () => ({ backend: "codex", threadId: "one", archivedAt: 2, cleanup: [] }) });
    await api.archiveThread!({ backend: "codex", threadId: "one" });
    const page = await api.getNavigationQueryPage!({ protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } });
    expect(page.counts.total).toBe(0);
    expect(page.entries).toEqual([]);
  });
});
