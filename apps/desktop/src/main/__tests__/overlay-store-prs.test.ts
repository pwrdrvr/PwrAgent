import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: SqliteOverlayStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-prs-test-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new SqliteOverlayStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
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

  it("scopes prs per (backend, threadId)", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prMerged],
    });
    await store.setThreadPullRequests({
      backend: "grok",
      threadId: "thread-1",
      prs: [prPassing],
    });

    const codex = await store.getThreadOverlayState({
      backend: "codex",
      threadId: "thread-1",
    });
    const grok = await store.getThreadOverlayState({
      backend: "grok",
      threadId: "thread-1",
    });

    expect(codex?.prs).toEqual([prMerged]);
    expect(grok?.prs).toEqual([prPassing]);
  });

  it("survives close + reopen so chips appear instantly on relaunch", async () => {
    await store.setThreadPullRequests({
      backend: "codex",
      threadId: "thread-1",
      prs: [prMerged],
    });

    const dbPath = path.join(tempDir, "state.db");
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

  it("persists canonical PR status cache rows across reopen", async () => {
    await store.writePrStatusCacheEntries([
      {
        provider: "github.com",
        prKey: "github.com/pwrdrvr/pwragent#179",
        fetchedAt: 1234,
        pr: prPassing,
      },
    ]);

    const dbPath = path.join(tempDir, "state.db");
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

  it("persists branch lookup cache rows across reopen", async () => {
    await store.writePrLookupCacheEntry({
      lookupKey: "{\"lookupVersion\":2,\"provider\":\"github.com\",\"branch\":\"feat/pr-chip\",\"directoryPaths\":[\"/repo\"]}",
      provider: "github.com",
      branch: "feat/pr-chip",
      directoryPaths: ["/repo"],
      fetchedAt: 2345,
      prs: [prPassing],
    });

    const dbPath = path.join(tempDir, "state.db");
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
