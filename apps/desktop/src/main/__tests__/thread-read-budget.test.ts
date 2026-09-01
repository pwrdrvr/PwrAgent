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

describe("thread read budgets across product flows", () => {
  it("labels a burst of terminal notifications with one walk per unobserved thread", async () => {
    // Turn completions arrive in bursts across concurrent threads. A thread
    // this process never listed still deserves a label, but it must cost one
    // reconciliation, not one per notification.
    const { client, registry } = build([
      codexThread({ id: "thread-alpha", title: "Alpha", titleSource: "derived" }),
      codexThread({ id: "thread-beta", title: "Beta", titleSource: "derived" }),
    ]);

    await Promise.all(
      ["thread-alpha", "thread-beta"].flatMap((threadId) =>
        Array.from({ length: 4 }, (_unused, turn) =>
          publishNotification(registry, {
            method: "turn/completed",
            params: {
              threadId,
              turnId: `turn-${turn}`,
              turn: { id: `turn-${turn}`, status: "completed", output: [] },
            },
          }),
        ),
      ),
    );

    expectThreadReadBudget({
      note: "eight terminal notifications across two threads neither of which was ever listed",
      reads: client.counts,
      scenario: "terminal-notification-burst",
    });
  });

  it("reads the provider once for a window opening onto a warm profile", async () => {
    // A second window mounting asks for the same navigation data the first
    // window already fetched, then immediately reads labels for its rows.
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    client.resetCounts();

    await registry.listThreads(NAVIGATION_REFRESH);
    for (const threadId of ["thread-alpha", "thread-beta"]) {
      expect(registry.getThreadInfo({ backend: "codex", threadId })?.title)
        .toBeDefined();
    }

    expectThreadReadBudget({
      note: "a second window's navigation refresh and label reads against a warm list cache",
      reads: client.counts,
      scenario: "second-window-navigation",
    });
  });

  it("keeps a turn's workspace lookups off the provider once the thread is known", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    client.resetCounts();

    // Ten turns, each of which adopts a branch on start and reports a cwd.
    for (let turn = 0; turn < 10; turn += 1) {
      await publishNotification(registry, {
        method: "turn/started",
        params: { threadId: "thread-alpha", turnId: `turn-${turn}`, turn: { id: `turn-${turn}` } },
      });
      await publishNotification(registry, {
        method: "turn/completed",
        params: {
          threadId: "thread-alpha",
          turnId: `turn-${turn}`,
          turn: { id: `turn-${turn}`, status: "completed", output: [] },
        },
      });
    }

    expectThreadReadBudget({
      note: "ten complete turns on a thread the navigation refresh already observed",
      reads: client.counts,
      scenario: "ten-turns-warm-thread",
    });
  });
});

describe("directory enrichment budget", () => {
  // A worktree-shaped projectKey is what makes the registry reach for
  // directory enrichment. Without one no scenario above can move the
  // enrichment counter, and a budget that cannot move proves nothing.
  const WORKTREE_THREAD = codexThread({
    id: "thread-worktree",
    projectKey: "/Users/example/.worktrees/feature-branch",
    title: "Worktree thread",
    titleSource: "explicit",
  });

  it("enriches a worktree thread's directories once per backfill-capable listing", async () => {
    const { client, registry } = build([WORKTREE_THREAD]);
    await registry.listThreads(NAVIGATION_REFRESH);

    expect(client.directoryEnrichmentCallCount).toBeGreaterThan(0);
    expectThreadReadBudget({
      note: "one navigation refresh over a single worktree-backed thread",
      reads: client.counts,
      scenario: "worktree-navigation-refresh",
    });
  });

  it("does not re-enrich a worktree thread for label reads across turns", async () => {
    const { client, registry } = build([WORKTREE_THREAD]);
    await registry.listThreads(NAVIGATION_REFRESH);
    client.resetCounts();

    for (let turn = 0; turn < 5; turn += 1) {
      await publishNotification(registry, {
        method: "turn/started",
        params: { threadId: "thread-worktree", turnId: `turn-${turn}`, turn: { id: `turn-${turn}` } },
      });
      expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-worktree" })?.title)
        .toBe("Worktree thread");
      await publishNotification(registry, {
        method: "turn/completed",
        params: {
          threadId: "thread-worktree",
          turnId: `turn-${turn}`,
          turn: { id: `turn-${turn}`, status: "completed", output: [] },
        },
      });
    }

    expectThreadReadBudget({
      note: "five turns on an already-enriched worktree thread",
      reads: client.counts,
      scenario: "worktree-turns-after-enrichment",
    });
  });
});

describe("archival is an observation, not a cache eviction", () => {
  it("records that a thread was archived without losing its title", async () => {
    const { registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "thread/archived",
      params: { threadId: "thread-alpha" },
    });

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" }))
      .toMatchObject({ archived: true, title: "Rework the quit dialog" });
  });

  it("records a restore over the archival", async () => {
    const { registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "thread/archived",
      params: { threadId: "thread-alpha" },
    });
    await publishNotification(registry, {
      method: "thread/unarchived",
      params: { threadId: "thread-alpha" },
    });

    expect(registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })?.archived)
      .toBe(false);
  });
});

describe("messaging admission reads what this process already knows", () => {
  // resolveThread falls back to listThreads({ forceRefresh: true }) — a full
  // paged provider walk — whenever the cached summary comes back empty. The
  // thread-list cache is emptied by every mutation, so before the information
  // store answered here, an inbound reply to a thread this window listed
  // minutes ago paid that walk because something unrelated had invalidated the
  // cache in between.
  it("admits a reply after an invalidation without listing the provider", async () => {
    const { client, registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    // An unrelated mutation on a different thread empties the whole cache.
    await registry.archiveThread({ backend: "codex", threadId: "thread-beta" });
    client.resetCounts();

    const summary = registry.getCachedThreadSummary({
      backend: "codex",
      threadId: "thread-alpha",
    });
    expect(summary?.title).toBe("Rework the quit dialog");
    await expect(
      registry.resolveThread({ threadId: "thread-alpha" }),
    ).resolves.toMatchObject({ id: "thread-alpha" });

    expectThreadReadBudget({
      note: "messaging admission for a listed thread whose list cache was invalidated",
      reads: client.counts,
      scenario: "messaging-admission-after-invalidation",
    });
  });

  // The caller does not always know which backend owns the thread an inbound
  // message names.
  it("answers a backend-less lookup from the store", async () => {
    const { registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await registry.archiveThread({ backend: "codex", threadId: "thread-alpha" });

    expect(
      registry.getCachedThreadSummary({ threadId: "thread-beta" })?.title,
    ).toBe("Audit the messaging adapters");
    expect(
      registry.getCachedThreadSummary({ threadId: "no-such-thread" }),
    ).toBeUndefined();
  });
});

// Messaging admission and the quit dialog read this process's own knowledge
// rather than the provider. That is only safe while what it knows is current.
describe("what the store serves stays current", () => {
  it("admits a reply under the renamed title, not the listed one", async () => {
    const { registry } = build([NAMED_THREAD]);
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "thread/name/updated",
      params: { threadId: "thread-alpha", threadName: "Renamed after listing" },
    });

    expect(
      registry.getCachedThreadSummary({
        backend: "codex",
        threadId: "thread-alpha",
      })?.title,
    ).toBe("Renamed after listing");
    await expect(
      registry.resolveThread({ threadId: "thread-alpha" }),
    ).resolves.toMatchObject({ title: "Renamed after listing" });
  });

  // resolveThread's provider fallback filters archived:false. Answering from
  // the store has to honour the same thing, or a reply is admitted to a thread
  // the operator archived.
  it("stops resolving a thread once it is archived", async () => {
    const { registry } = build();
    await registry.listThreads(NAVIGATION_REFRESH);
    await registry.archiveThread({ backend: "codex", threadId: "thread-alpha" });
    await publishNotification(registry, {
      method: "thread/archived",
      params: { threadId: "thread-alpha" },
    });

    expect(
      registry.getCachedThreadSummary({
        backend: "codex",
        threadId: "thread-alpha",
      }),
    ).toBeUndefined();
    await expect(
      registry.resolveThread({ threadId: "thread-alpha" }),
    ).resolves.toBeUndefined();
    // The untouched thread is unaffected.
    await expect(
      registry.resolveThread({ threadId: "thread-beta" }),
    ).resolves.toMatchObject({ id: "thread-beta" });
  });

  // thread/started replays the provider's own record, which on a resume is
  // the pre-rename one. Sequence order alone would let it win.
  it("keeps an unacknowledged rename over a resumed thread's own record", async () => {
    const { registry } = build([NAMED_THREAD]);
    await registry.listThreads(NAVIGATION_REFRESH);
    await publishNotification(registry, {
      method: "thread/name/updated",
      params: { threadId: "thread-alpha", threadName: "Renamed By Operator" },
    });
    await publishNotification(registry, {
      method: "thread/started",
      params: {
        threadId: "thread-alpha",
        thread: {
          id: "thread-alpha",
          title: "Rework the quit dialog",
          titleSource: "explicit",
        },
      },
    });

    expect(
      registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })
        ?.title,
    ).toBe("Renamed By Operator");
  });

  // An unfiltered listing returns archived and active rows alike, so it proves
  // nothing about either.
  it("does not read archival into a listing that did not filter for it", async () => {
    const { registry } = build();
    await publishNotification(registry, {
      method: "thread/archived",
      params: { threadId: "thread-alpha" },
    });
    await registry.listThreads({
      backend: "codex",
      callerReason: "navigation-snapshot",
      enrichDirectories: false,
      forceRefresh: true,
    });

    expect(
      registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })
        ?.archived,
    ).toBe(true);
  });

  // A listing that failed is not an answer. Memoizing it would silence this
  // thread's terminal notifications for the rest of the process.
  it("retries a terminal-notification lookup that failed", async () => {
    const { client, registry } = build();
    client.failNextList = true;
    await publishNotification(registry, {
      method: "turn/completed",
      params: {
        threadId: "thread-alpha",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "completed", output: [] },
      },
    });
    const listsAfterFailure = client.listCalls.length;

    await publishNotification(registry, {
      method: "turn/completed",
      params: {
        threadId: "thread-alpha",
        turnId: "turn-2",
        turn: { id: "turn-2", status: "completed", output: [] },
      },
    });

    expect(client.listCalls.length).toBeGreaterThan(listsAfterFailure);
    expect(
      registry.getThreadInfo({ backend: "codex", threadId: "thread-alpha" })
        ?.title,
    ).toBe("Rework the quit dialog");
  });
});
