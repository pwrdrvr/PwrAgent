import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexThread,
  createThreadReadRegistry,
  publishNotification,
} from "./fixtures/thread-read-harness";
import { expectThreadReadBudget } from "./fixtures/thread-read-budget";

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

const NAMED_THREAD = codexThread({
  id: "thread-alpha",
  title: "Rework the quit dialog",
  titleSource: "explicit",
});
const SECOND_THREAD = codexThread({
  id: "thread-beta",
  title: "Audit the messaging adapters",
  titleSource: "explicit",
});

/** The read a freshly opened window makes to paint its sidebar. */
const NAVIGATION_REFRESH = {
  backend: "codex",
  callerReason: "navigation-snapshot",
  enrichDirectories: false,
} as const;

const registries: Array<{ close: () => Promise<unknown> }> = [];

function build(threads = [NAMED_THREAD, SECOND_THREAD]) {
  const created = createThreadReadRegistry(threads);
  registries.push(created.registry);
  return created;
}

afterEach(async () => {
  await Promise.all(registries.splice(0).map(async (registry) => {
    await registry.close();
  }));
});

describe("thread read budgets", () => {
  it("names quit blockers for the life of the dialog without reading the provider", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "turn/started",
      params: { threadId: "thread-alpha", turnId: "turn-1", turn: { id: "turn-1" } },
    });
    client.resetCounts();

    // The quit toast re-reads this snapshot every 500ms while it is open.
    for (let poll = 0; poll < 20; poll += 1) {
      expect(registry.getInProgressThreadSnapshotForQuit()).toEqual({
        count: 1,
        threadIds: ["codex:thread-alpha"],
        threadTitles: { "codex:thread-alpha": "Rework the quit dialog" },
      });
    }

    expectThreadReadBudget({
      note: "20 quit-dialog polls against an in-progress turn, all served from observed metadata",
      reads: client.counts,
      scenario: "quit-dialog-poll",
    });
  });

  it("answers repeated label lookups for a known thread without reading the provider", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    client.resetCounts();

    for (let lookup = 0; lookup < 50; lookup += 1) {
      expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
        .toBe("Rework the quit dialog");
    }

    expectThreadReadBudget({
      note: "50 synchronous label lookups for a thread already observed once",
      reads: client.counts,
      scenario: "known-thread-label-lookups",
    });
  });

  it("keeps labels answerable across a turn's lifecycle events", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    client.resetCounts();

    // A turn invalidates list caches repeatedly. None of it is a reason to
    // forget what the threads are called.
    for (let turn = 0; turn < 5; turn += 1) {
      await publishNotification(registry, {
        method: "turn/started",
        params: { threadId: "thread-alpha", turnId: `turn-${turn}`, turn: { id: `turn-${turn}` } },
      });
      expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
        .toBe("Rework the quit dialog");
      await publishNotification(registry, {
        method: "turn/completed",
        params: {
          threadId: "thread-alpha",
          turnId: `turn-${turn}`,
          turn: { id: `turn-${turn}`, status: "completed", output: [] },
        },
      });
      expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
        .toBe("Rework the quit dialog");
    }

    expectThreadReadBudget({
      note: "five complete turns with label reads between every lifecycle event",
      reads: client.counts,
      scenario: "turn-lifecycle-label-reads",
    });
  });

  it("shares one provider read across callers that want the same listing", async () => {
    const { client, registry } = build();
    await Promise.all([
      registry.listThreads(NAVIGATION_REFRESH),
      registry.listThreads({ backend: "codex", callerReason: "navigation-snapshot", enrichDirectories: false }),
      registry.listThreads({ backend: "codex", callerReason: "startup-prewarm", enrichDirectories: false }),
      registry.listThreads({ backend: "codex", callerReason: "branch-drift", enrichDirectories: false }),
      registry.listThreads({ backend: "codex", callerReason: "turn-cwd", enrichDirectories: false }),
      registry.listThreads({ backend: "codex", callerReason: "title-generation", enrichDirectories: false }),
    ]);

    expectThreadReadBudget({
      note: "six concurrent callers asking for the same unenriched Codex listing",
      reads: client.counts,
      scenario: "concurrent-identical-listings",
    });
  });
});

describe("thread information is never lost", () => {
  it("keeps a known title when the provider becomes unavailable", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Rework the quit dialog");

    client.failNextList = true;
    await registry.listThreads({ ...NAVIGATION_REFRESH, forceRefresh: true })
      .catch(() => undefined);

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Rework the quit dialog");
  });

  it("keeps a known title when the provider starts reporting a fallback", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);

    // A provider that loses its title index answers with the thread id. That
    // is the absence of a name, not the news that the name is now a uuid.
    client.setThreads([codexThread({ id: "thread-alpha" })]);
    await registry.listThreads({ ...NAVIGATION_REFRESH, forceRefresh: true });

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Rework the quit dialog");
  });

  it("prefers a rename to a listing that started before it", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);

    let releaseList: () => void = () => {};
    client.listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const staleList = registry.listThreads({ ...NAVIGATION_REFRESH, forceRefresh: true });

    await publishNotification(registry, {
      method: "thread/name/updated",
      params: { threadId: "thread-alpha", threadName: "Renamed mid-listing" },
    });
    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Renamed mid-listing");

    releaseList();
    await staleList;

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Renamed mid-listing");
  });

  it("adopts a title the provider reports after a rename", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "thread/name/updated",
      params: { threadId: "thread-alpha", threadName: "Renamed locally" },
    });

    client.setThreads([
      codexThread({
        id: "thread-alpha",
        title: "Renamed locally, then edited elsewhere",
        titleSource: "explicit",
      }),
    ]);
    await registry.listThreads({ ...NAVIGATION_REFRESH, forceRefresh: true });

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.title)
      .toBe("Renamed locally, then edited elsewhere");
  });

  it("does not let one backend's thread id answer for another's", async () => {
    const { registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    expect(registry.getThreadInfo({ backend: "acp:claude-code", threadId: "thread-alpha" }))
      .toBeUndefined();
  });
});
