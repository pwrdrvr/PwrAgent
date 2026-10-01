import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, NavigationDirectorySummary, NavigationLaunchpadDraft } from "@pwragent/shared";
import {
  directorySetFingerprint,
  directorySetMayHaveChanged,
  DIRECTORY_SET_RECHECK_INTERVAL_MS,
  NavigationDirectorySetAnnouncer,
} from "../app-server/navigation-directory-set-announcer";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import type { StateDb } from "../state/state-db";
import { openInMemoryStateDb } from "./sqlite-test-utils";

const directory = (
  key: string,
  overrides: Partial<NavigationDirectorySummary> = {},
): NavigationDirectorySummary => ({
  key,
  kind: "directory",
  label: key.split("/").pop()!,
  path: key.replace(/^directory:/, ""),
  threadKeys: [],
  needsAttentionCount: 0,
  ...overrides,
});
const event = (method: string, params: Record<string, unknown> = {}) => ({
  backend: "codex",
  notification: { method, params },
}) as AgentEvent;

describe("directorySetFingerprint", () => {
  const base = [directory("directory:/src/ProjectA"), directory("directory:/src/ProjectB")];

  it("ignores row order and everything that moves with thread activity", () => {
    expect(directorySetFingerprint([
      directory("directory:/src/ProjectB", {
        threadKeys: ["codex:thread-1"],
        needsAttentionCount: 3,
        latestUpdatedAt: 99,
        pinnedRank: "a",
        gitStatus: { currentBranch: "main", originRepository: undefined },
      }),
      directory("directory:/src/ProjectA", { directoryThreadsCollapsed: true }),
    ])).toBe(directorySetFingerprint(base));
  });

  it("changes with every field a viewer matches a project on", () => {
    const changes: NavigationDirectorySummary[][] = [
      [...base, directory("directory:/src/ProjectC")],
      [base[0]!],
      [{ ...base[0]!, label: "Renamed" }, base[1]!],
      [{ ...base[0]!, path: "/elsewhere/ProjectA" }, base[1]!],
      [{ ...base[0]!, kind: "workspace" }, base[1]!],
      [{ ...base[0]!, localAvailability: "unconfigured" }, base[1]!],
      [{ ...base[0]!, gitStatus: { originRepository: "github.com/acme/project-a" } }, base[1]!],
    ];
    for (const changed of changes) {
      expect(directorySetFingerprint(changed)).not.toBe(directorySetFingerprint(base));
    }
  });
});

describe("directorySetMayHaveChanged", () => {
  it("re-checks for membership changes and origins, not turn activity", () => {
    expect(directorySetMayHaveChanged(event("thread/started", { thread: { id: "t" } }))).toBe(true);
    expect(directorySetMayHaveChanged(event("navigation/threadDirectories/updated", { threadId: "t" }))).toBe(true);
    expect(directorySetMayHaveChanged(event("navigation/directory/removed", { directoryKey: "k" }))).toBe(true);
    expect(directorySetMayHaveChanged(event("navigation/providerThreads/refreshed"))).toBe(true);
    expect(directorySetMayHaveChanged(event("navigation/directoryGitStatus/updated", { directoryKey: "k" }))).toBe(true);
    expect(directorySetMayHaveChanged(event("turn/completed", { threadId: "t" }))).toBe(false);
    expect(directorySetMayHaveChanged(event("thread/status/changed", { threadId: "t" }))).toBe(false);
    expect(directorySetMayHaveChanged(event("item/agentMessage/delta", { threadId: "t" }))).toBe(false);
    // Its own announcement must not schedule another build.
    expect(directorySetMayHaveChanged(event("navigation/directorySet/changed", { reason: "changed" }))).toBe(false);
  });
});

describe("NavigationDirectorySetAnnouncer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function announcer() {
    const published: string[] = [];
    const rebuilds: Array<{ refreshProviders: boolean }> = [];
    let changed: (() => void) | undefined;
    const unsubscribe = vi.fn();
    let finishRebuild: (() => void) | undefined;
    let holdRebuilds = false;
    const instance = new NavigationDirectorySetAnnouncer({
      publish: (reason) => published.push(reason),
      rebuild: (options) => {
        rebuilds.push(options);
        return holdRebuilds
          ? new Promise<void>((resolve) => { finishRebuild = resolve; })
          : Promise.resolve();
      },
      subscribeInputs: (listener) => {
        changed = listener;
        return unsubscribe;
      },
      settleMs: 250,
    });
    return {
      instance,
      published,
      rebuilds,
      unsubscribe,
      inputChanged: () => changed?.(),
      hold: () => { holdRebuilds = true; },
      finish: () => { holdRebuilds = false; finishRebuild?.(); },
    };
  }

  it("announces a changed directory set only while watched", () => {
    const { instance, published } = announcer();
    const before = [directory("directory:/src/ProjectA")];
    const after = [...before, directory("directory:/src/ProjectB")];

    instance.observe(before);
    instance.observe(after);
    expect(published).toEqual([]);

    instance.setWatched(true);
    instance.observe(after);
    expect(published).toEqual([]);
    instance.observe(before);
    expect(published).toEqual(["changed"]);
  });

  it("rebuilds once after a burst of input changes, and again for one made during the build", async () => {
    const harness = announcer();
    harness.instance.setWatched(true);
    harness.hold();
    harness.inputChanged();
    harness.inputChanged();
    await vi.advanceTimersByTimeAsync(249);
    expect(harness.rebuilds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.rebuilds).toEqual([{ refreshProviders: false }]);

    harness.inputChanged();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.rebuilds).toHaveLength(1);
    harness.finish();
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.rebuilds).toEqual([{ refreshProviders: false }, { refreshProviders: false }]);
  });

  it("re-lists provider threads on the re-check interval", async () => {
    const harness = announcer();
    harness.instance.setWatched(true);
    await vi.advanceTimersByTimeAsync(DIRECTORY_SET_RECHECK_INTERVAL_MS + 250);
    expect(harness.rebuilds).toEqual([{ refreshProviders: true }]);
  });

  it("does nothing while unwatched", async () => {
    const harness = announcer();
    harness.instance.setWatched(true);
    harness.instance.setWatched(false);
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    harness.inputChanged();
    await vi.advanceTimersByTimeAsync(DIRECTORY_SET_RECHECK_INTERVAL_MS * 2);
    expect(harness.rebuilds).toEqual([]);
  });
});

describe("SqliteOverlayStore.onDirectoryLaunchpadsChanged", () => {
  let stateDb: StateDb;
  let store: SqliteOverlayStore;

  beforeEach(() => {
    stateDb = openInMemoryStateDb();
    store = new SqliteOverlayStore(stateDb);
  });
  afterEach(() => {
    stateDb.close();
  });

  const launchpad = (overrides: Partial<NavigationLaunchpadDraft> = {}): NavigationLaunchpadDraft => ({
    directoryKey: "directory:/src/ProjectA",
    directoryKind: "directory",
    directoryLabel: "ProjectA",
    directoryPath: "/src/ProjectA",
    backend: "codex",
    executionMode: "default",
    prompt: "",
    workMode: "local",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  const directorySet = () => directorySetFingerprint(
    store.readNavigationQueryIndex({ backend: "all", threads: [] }).directories,
  );

  it("fires exactly when a launchpad write changes the index's directory set", async () => {
    const listener = vi.fn();
    store.onDirectoryLaunchpadsChanged(listener);
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["an empty draft", () => store.upsertDirectoryLaunchpad(launchpad())],
      ["the first typed character", () => store.upsertDirectoryLaunchpad(launchpad({ prompt: "h" }))],
      ["more typing", () => store.upsertDirectoryLaunchpad(launchpad({ prompt: "hello", updatedAt: 2 }))],
      ["a cleared draft", () => store.upsertDirectoryLaunchpad(launchpad({ prompt: " ", updatedAt: 3 }))],
      ["a registration", () => store.upsertDirectoryLaunchpad(launchpad({ registeredAt: 4 }))],
      ["a settings touch", () => store.upsertDirectoryLaunchpad(launchpad({ settingsTouchedAt: 5 }))],
      ["a relabel", () => store.upsertDirectoryLaunchpad(launchpad({ directoryLabel: "Project A" }))],
      ["a reset", () => store.resetDirectoryLaunchpad({ directoryKey: "directory:/src/ProjectA" })],
      ["a reset of nothing", () => store.resetDirectoryLaunchpad({ directoryKey: "directory:/src/ProjectA" })],
    ];
    const observed: Array<[string, boolean, boolean]> = [];
    for (const [name, write] of writes) {
      const before = directorySet();
      listener.mockClear();
      await write();
      observed.push([name, directorySet() !== before, listener.mock.calls.length > 0]);
    }
    for (const [name, changed, notified] of observed) {
      expect({ name, notified }).toEqual({ name, notified: changed });
    }
    expect(observed.filter(([, changed]) => changed).map(([name]) => name)).toEqual([
      "the first typed character", "a cleared draft", "a registration", "a relabel", "a reset",
    ]);
  });
});
