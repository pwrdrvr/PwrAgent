import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import {
  createTempStateDb,
  openInMemoryStateDb,
  removeTempStateDbDir,
} from "./sqlite-test-utils";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string | undefined;

/**
 * Move this test onto a real database file and return its path. Only the
 * tests that close the database and reopen the same path need one: a second
 * `:memory:` open is a second empty database, so those assertions would hold
 * while testing nothing.
 */
function useFileStateDb(): string {
  stateDb.close();
  const temp = createTempStateDb("pwragent-prs-test-");
  tempDir = temp.tempDir;
  stateDb = StateDb.open(temp.dbPath);
  store = new SqliteOverlayStore(stateDb);
  return temp.dbPath;
}

beforeEach(() => {
  tempDir = undefined;
  stateDb = openInMemoryStateDb();
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  if (tempDir !== undefined) {
    removeTempStateDbDir(tempDir);
  }
});

const prMerged: PrSummary = pr({
  provider: "github.com",
  number: 178,
  org: "pwrdrvr",
  repo: "PwrAgent",
  state: "merged",
  url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
});

const prPassing: PrSummary = pr({
  provider: "github.com",
  number: 179,
  org: "pwrdrvr",
  repo: "PwrAgent",
  state: "passing",
  url: "https://github.com/pwrdrvr/PwrAgent/pull/179",
});

const prFailingWithRunningChecks: PrSummary = pr({
  provider: "github.com",
  number: 180,
  org: "pwrdrvr",
  repo: "PwrAgent",
  state: "failing",
  checksStillRunning: true,
  url: "https://github.com/pwrdrvr/PwrAgent/pull/180",
});

const enterprisePrPassing: PrSummary = pr({
  provider: "ghe.pwrdrvr.test",
  number: 179,
  org: "pwrdrvr",
  repo: "PwrAgent",
  state: "passing",
  url: "https://ghe.pwrdrvr.test/pwrdrvr/PwrAgent/pull/179",
});

function pr(
  value: Omit<PrSummary, "checkState" | "lifecycleState" | "reviewState" | "mergeState">
    & Partial<Pick<PrSummary, "checkState" | "lifecycleState" | "reviewState" | "mergeState">>,
): PrSummary {
  const checkState = value.checkState ?? normalizeCheckState(value.state);
  return {
    ...value,
    state: checkState,
    checkState,
    lifecycleState: value.lifecycleState ?? legacyLifecycleState(value.state),
    reviewState: value.reviewState ?? (value.state === "draft" ? "draft" : "ready_for_review"),
    mergeState: value.mergeState ?? "unknown",
  };
}

function normalizeCheckState(state: PrSummary["state"]): NonNullable<PrSummary["checkState"]> {
  if (
    state === "passing"
    || state === "failing"
    || state === "pending"
    || state === "unknown"
  ) {
    return state;
  }
  return "unknown";
}

function legacyLifecycleState(state: PrSummary["state"]): NonNullable<PrSummary["lifecycleState"]> {
  if (state === "merged" || state === "closed") {
    return state;
  }
  return "open";
}

describe("SqliteOverlayStore — thread PRs", () => {
  it("migrates legacy detach tombstones without suppressing a same-number fork PR", async () => {
    const dbPath = useFileStateDb();
    const identity = { backend: "codex" as const, threadId: "legacy-detach" };
    const fork = { ...prPassing, number: 38, org: "fork", repo: "project",
      url: "https://github.com/fork/project/pull/38" };
    const upstream = { ...fork, url: "https://github.com/upstream/project/pull/38" };
    const overlay = await store.setThreadPullRequests({ ...identity, prs: [] });
    stateDb.raw.prepare("UPDATE threads SET payload = ?").run(JSON.stringify({
      ...overlay, detachedPrKeys: ["github.com/fork/project#38"], detachedPrs: [upstream],
    }));
    stateDb.raw.pragma("user_version = 62");
    stateDb.close();
    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
    const migrated = await store.getThreadOverlayState(identity);
    expect(migrated?.detachedPrKeys).toEqual(["github.com/upstream/project#38"]);
    expect(migrated?.detachedPrs?.[0]).toMatchObject({ org: "upstream" });
    const refreshed = await store.setThreadPullRequests({ ...identity, prs: [fork, upstream] });
    expect(refreshed.prs).toEqual([fork]);
  });

  it("starts with no prs on a thread that has never been touched", async () => {
    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay).toBeUndefined();
  });

  it("persists prs and surfaces them through getThreadOverlayState", async () => {
    const next = await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prPassing],
      refreshKey: "codex:thread-1:feat/pr-chip:/repo",
    });
    expect(next.prs).toEqual([prPassing]);
    expect(next.prsRefreshKey).toBe("codex:thread-1:feat/pr-chip:/repo");

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prs).toEqual([prPassing]);
    expect(overlay?.prsRefreshKey).toBe("codex:thread-1:feat/pr-chip:/repo");
  });

  it("preserves a failure that still has running checks", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prFailingWithRunningChecks],
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prs).toEqual([prFailingWithRunningChecks]);
  });

  it("replaces prs (last write wins) so state transitions land", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [pr({ ...prPassing, state: "pending", checkState: "pending" })],
    });
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [pr({ ...prPassing, state: "failing", checkState: "failing" })],
    });

    const overlay = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prs?.[0]?.state).toBe("failing");
  });

  it("rejects an older PR lookup completion for the same thread", async () => {
    const newerPr = pr({
      ...prPassing,
      mergeState: "conflicting",
    });
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [newerPr],
      fetchedAt: 2000,
      refreshKey: "newer-request",
    });

    const result = await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prPassing],
      fetchedAt: 1000,
      refreshKey: "older-request",
    });

    expect(result.prs).toEqual([newerPr]);
    expect(result.prsFetchedAt).toBe(2000);
    expect(result.prsRefreshKey).toBe("newer-request");
    await expect(store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    })).resolves.toEqual(expect.objectContaining({
      prs: [newerPr],
      prsFetchedAt: 2000,
      prsRefreshKey: "newer-request",
    }));
  });

  it("scopes prs per (backend, threadId)", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prMerged],
    });
    await store.setThreadPullRequests({
      backend: "acp:grok",
      threadId: "thread-1",
      prs: [prPassing],
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "acp:grok",
      threadId: "thread-1",
    });

    expect(codex?.prs).toEqual([prMerged]);
    expect(grok?.prs).toEqual([prPassing]);
  });

  it("survives close + reopen so chips appear instantly on relaunch", async () => {
    const dbPath = useFileStateDb();
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prMerged],
    });

    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    const overlay = await reopenedStore.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(overlay?.prs).toEqual([prMerged]);
    reopened.close();

    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("clearing with [] removes all prs", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prPassing],
    });
    const next = await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [],
    });
    expect(next.prs).toEqual([]);
  });

  it("keeps detached prs hidden across later refresh writes", async () => {
    const detachedPrSha = "a".repeat(40);
    const detachedPr: PrSummary = {
      ...prPassing,
      lifecycleState: "merged",
      commitShas: [detachedPrSha],
    };

    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [detachedPr, prMerged],
    });

    const detached = await store.detachThreadPullRequest({
      backend: "codex",
      threadId: "thread-1",
      pr: detachedPr,
    });
    expect(detached.detachedPrKeys).toEqual([
      "github.com/pwrdrvr/pwragent#179",
    ]);
    expect(detached.detachedPrs).toEqual([detachedPr]);
    expect(detached.prs).toEqual([prMerged]);

    const refreshed = await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prMerged],
    });
    expect(refreshed.detachedPrKeys).toEqual([
      "github.com/pwrdrvr/pwragent#179",
    ]);
    expect(refreshed.detachedPrs).toEqual([detachedPr]);
    expect(refreshed.prs).toEqual([prMerged]);
  });

  it("explicitly adding a PR reference makes a previously detached PR visible again", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prPassing, prMerged],
    });
    await store.detachThreadPullRequest({
      backend: "codex",
      threadId: "thread-1",
      pr: prPassing,
    });

    const added = await store.addThreadPullRequestReference({
      backend: "codex",
      threadId: "thread-1",
      pr: {
        ...prPassing,
        title: "Explicitly restored PR",
      },
    });

    expect(added.detachedPrKeys).toEqual([]);
    expect(added.detachedPrs).toBeUndefined();
    expect(added.prs).toEqual([
      prMerged,
      {
        ...prPassing,
        title: "Explicitly restored PR",
      },
    ]);
  });

  it("appends explicitly attached PRs in attachment order", async () => {
    const olderAttachment = pr({
      ...prPassing,
      number: 735,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/735",
    });
    const newerAttachment = pr({
      ...prPassing,
      number: 1191,
      url: "https://github.com/pwrdrvr/PwrAgent/pull/1191",
    });

    await store.addThreadPullRequestReference({
      backend: "codex",
      threadId: "thread-1",
      pr: olderAttachment,
    });
    const added = await store.addThreadPullRequestReference({
      backend: "codex",
      threadId: "thread-1",
      pr: newerAttachment,
    });

    expect(added.prs?.map((pullRequest) => pullRequest.number)).toEqual([
      735,
      1191,
    ]);
  });

  it("rekeys legacy cache rows by URL and keeps the newest observation after collisions", async () => {
    const upstream = pr({ ...prPassing, number: 38, org: "upstream", repo: "diskhound",
      title: "New upstream status", url: "https://github.com/upstream/diskhound/pull/38" });
    const insert = stateDb.raw.prepare(
      "INSERT INTO pr_status_cache(pr_key, provider, org, repo, number, fetched_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    // Old releases wrote the source repo into both the SQL key and payload.
    insert.run("github.com/fork/diskhound#38", "github.com", "fork", "diskhound", 38, 2000,
      JSON.stringify({ ...upstream, org: "fork" }));
    insert.run("github.com/upstream/diskhound#38", "github.com", "upstream", "diskhound", 38, 1000,
      JSON.stringify({ ...upstream, title: "Old upstream status" }));
    const cached = await store.readPrStatusCache();
    expect(Object.keys(cached)).toEqual(["github.com/upstream/diskhound#38"]);
    expect(cached["github.com/upstream/diskhound#38"]).toMatchObject({ fetchedAt: 2000, pr: upstream });
  });

  it("writes colliding legacy summaries under their distinct destination keys", async () => {
    const fork = pr({ ...prPassing, number: 38, org: "fork", repo: "diskhound",
      title: "Fork changes", url: "https://github.com/fork/diskhound/pull/38" });
    const upstream = { ...fork, title: "Upstream changes", url: "https://github.com/upstream/diskhound/pull/38" };
    await store.writePrStatusCacheEntries([fork, upstream].map((pr) => ({
      provider: "github.com", prKey: "github.com/fork/diskhound#38", fetchedAt: 2000, pr,
    })));
    const cached = await store.readPrStatusCache();
    expect(Object.keys(cached).sort()).toEqual(["github.com/fork/diskhound#38", "github.com/upstream/diskhound#38"]);
    expect(cached["github.com/fork/diskhound#38"]?.pr).toEqual(fork);
    expect(cached["github.com/upstream/diskhound#38"]?.pr).toEqual({ ...upstream, org: "upstream", sourceRepository: { provider: "github.com", org: "fork", repo: "diskhound" } });
  });

  it("retains both colliding attachments and detaches only the requested destination", async () => {
    const fork = pr({
      ...prPassing,
      number: 38,
      org: "fork",
      repo: "diskhound",
      url: "https://github.com/fork/diskhound/pull/38",
    });
    const upstream = {
      ...fork,
      url: "https://github.com/upstream/diskhound/pull/38",
    };
    const identity = { backend: "codex" as const, threadId: "overlapping-prs" };
    await store.addThreadPullRequestReference({ ...identity, pr: fork });
    const attached = await store.addThreadPullRequestReference({ ...identity, pr: upstream });
    expect(attached.prs).toEqual([fork, { ...upstream, org: "upstream", sourceRepository: { provider: "github.com", org: "fork", repo: "diskhound" } }]);
    const detached = await store.detachThreadPullRequest({ ...identity, pr: fork });
    expect(detached.prs).toEqual([{ ...upstream, org: "upstream", sourceRepository: { provider: "github.com", org: "fork", repo: "diskhound" } }]);
    expect(detached.detachedPrKeys).toEqual(["github.com/fork/diskhound#38"]);
  });

  it("persists canonical PR status cache rows across reopen", async () => {
    const dbPath = useFileStateDb();
    await store.writePrStatusCacheEntries([
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 1234,
        pr: prPassing,
      },
    ]);

    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    await expect(reopenedStore.readPrStatusCache()).resolves.toEqual({
      "github.com/pwrdrvr/pwragent#179": {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 1234,
        pr: prPassing,
      },
    });
    reopened.close();

    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("does not let an older PR status observation replace a newer cache row", async () => {
    const conflictingPr = {
      ...prPassing,
      mergeState: "conflicting" as const,
    };
    await store.writePrStatusCacheEntries([
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 2000,
        pr: conflictingPr,
      },
    ]);
    await store.writePrStatusCacheEntries([
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 1000,
        pr: prPassing,
      },
    ]);

    await expect(store.readPrStatusCache()).resolves.toEqual({
      "github.com/pwrdrvr/pwragent#179": {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 2000,
        pr: conflictingPr,
      },
    });
  });

  it("persists branch lookup cache rows across reopen", async () => {
    const dbPath = useFileStateDb();
    await store.writePrLookupCacheEntry({
      lookupKey: "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}",
      provider: "github.com",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      fetchedAt: 2345,
      prs: [prPassing],
    });

    stateDb.close();

    const reopened = StateDb.open(dbPath);
    const reopenedStore = new SqliteOverlayStore(reopened);
    await expect(reopenedStore.readPrLookupCache()).resolves.toEqual({
      "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}": {
        lookupKey: "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}",
        provider: "github.com",
        branch: "feat/pr-chip",
        directoryPaths: ["/repo"],
        fetchedAt: 2345,
        prs: [prPassing],
      },
    });
    reopened.close();

    stateDb = StateDb.open(dbPath);
    store = new SqliteOverlayStore(stateDb);
  });

  it("does not let an older branch lookup replace a newer cache row", async () => {
    const lookupKey = "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}";
    const conflictingPr = {
      ...prPassing,
      mergeState: "conflicting" as const,
    };
    await store.writePrLookupCacheEntry({
      lookupKey,
      provider: "github.com",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      fetchedAt: 2000,
      prs: [conflictingPr],
    });
    await store.writePrLookupCacheEntry({
      lookupKey,
      provider: "github.com",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      fetchedAt: 1000,
      prs: [prPassing],
    });

    await expect(store.readPrLookupCache()).resolves.toEqual({
      [lookupKey]: {
        lookupKey,
        provider: "github.com",
        branch: "feat/pr-chip",
        directoryPaths: ["/repo"],
        fetchedAt: 2000,
        prs: [conflictingPr],
      },
    });
  });

  it("preserves PR providers inside branch lookup cache payloads", async () => {
    await store.writePrLookupCacheEntry({
      lookupKey: "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}",
      provider: "github.com",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      fetchedAt: 2345,
      prs: [enterprisePrPassing],
    });

    const entries = await store.readPrLookupCache();

    expect(entries).toEqual({
      "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}": {
        lookupKey: "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}",
        provider: "github.com",
        branch: "feat/pr-chip",
        directoryPaths: ["/repo"],
        fetchedAt: 2345,
        prs: [enterprisePrPassing],
      },
    });
  });
});
