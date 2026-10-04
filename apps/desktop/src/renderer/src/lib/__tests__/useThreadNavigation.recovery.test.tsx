import "@testing-library/jest-dom/vitest";
import type { NavigationSnapshot, NavigationThreadSummary } from "@pwragent/shared";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigationOwnerApiFixture, type NavigationOwnerFixtureApi as DesktopApi } from "../../test/navigation-owner-api-fixture";
import { RendererRecoveryStateProvider, useRecoverableComposerDraftStore } from "../RendererRecoveryState";
import { useThreadNavigation } from "../useThreadNavigation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function thread(updatedAt = 1_000): NavigationThreadSummary {
  return {
    id: "thread-one", source: "codex", title: "Contrived thread", titleSource: "explicit", linkedDirectories: [], updatedAt,
    inbox: updatedAt > 1_000
      ? { inInbox: true, reason: "updated-since-seen", lastSeenUpdatedAt: 1_000 }
      : { inInbox: false, lastSeenUpdatedAt: 1_000 },
  };
}

function snapshot(threads: NavigationThreadSummary[] = [thread()]): NavigationSnapshot {
  return {
    backend: "all", fetchedAt: Date.now(), unchanged: false,
    inboxThreadKeys: threads.filter((item) => item.inbox.inInbox).map((item) => `${item.source}:${item.id}`),
    threads, directories: [], launchpadDefaults: { backend: "codex", executionMode: "default" },
  };
}

// Changing only this child's key models the subtree lifetime of a boundary
// recovery, while the window's recovery provider and main-owned API survive.
function createWindow(api: DesktopApi) {
  let current!: ReturnType<typeof useThreadNavigation>;
  let revision = 0;
  function Content() {
    const drafts = useRecoverableComposerDraftStore();
    const ownerApi = useMemo(() => navigationOwnerApiFixture(api, (launchpads) => {
      for (const launchpad of launchpads) {
        const scope = `launchpad:${launchpad.directoryKey}`;
        if (!drafts.get(scope)) drafts.set(scope, {
          draft: launchpad.prompt, imageAttachments: [], fileAttachments: [], skillTokens: [],
        });
      }
    }), [api, drafts]);
    const navigation = useThreadNavigation(ownerApi, { composerDraftStore: drafts });
    useLayoutEffect(() => { current = navigation; });
    return null;
  }
  const tree = () => <RendererRecoveryStateProvider draftsEnabled={false}><Content key={revision} /></RendererRecoveryStateProvider>;
  const view = render(tree());
  return {
    get current() { return current; },
    remount: () => { revision += 1; view.rerender(tree()); },
  };
}

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  (window as Window & { __pwragentNavigationPreferences?: unknown }).__pwragentNavigationPreferences = { browseMode: "inbox" };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as Window & { __pwragentNavigationPreferences?: unknown }).__pwragentNavigationPreferences;
});

describe("navigation boundary recovery", () => {
  it("retains the active lens instead of rereading the immutable startup hint", async () => {
    const window = createWindow({ readPopulation: async () => snapshot() });
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    act(() => window.current.setBrowseMode("attention"));
    expect(window.current.browseMode).toBe("attention");
    window.remount();
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    expect(window.current.browseMode).toBe("attention");
  });

  it("establishes startup selection when recovery precedes the initial read", async () => {
    const initial = deferred<NavigationSnapshot>();
    const readPopulation = vi.fn(() => initial.promise);
    const window = createWindow({ readPopulation });
    await waitFor(() => expect(readPopulation).toHaveBeenCalled());
    expect(window.current.selectedItemKey).toBeUndefined();
    window.remount();
    await act(async () => { initial.resolve(snapshot()); });
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
  });

  it("retains a settled empty startup without implicitly selecting later additions", async () => {
    let population = snapshot([]);
    const window = createWindow({ readPopulation: async () => population });
    await waitFor(() => expect(window.current.loading).toBe(false));
    population = snapshot();
    window.remount();
    await waitFor(() => expect(window.current.threads).toHaveLength(1));
    expect(window.current.selectedItemKey).toBeUndefined();
  });

  it.each(["inbox", "attention"] as const)("retains manual focus and %s unread policy", async (lens) => {
    let population = snapshot();
    const markThreadSeen = vi.fn<NonNullable<DesktopApi["markThreadSeen"]>>(async (request) => ({
      backend: request.backend, threadId: request.threadId, seenAt: Date.now(), seenUpdatedAt: request.seenUpdatedAt,
    }));
    const window = createWindow({ readPopulation: async () => population, markThreadSeen });
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    act(() => {
      window.current.setBrowseMode(lens);
    });
    act(() => window.current.selectThread(window.current.selectedThread!));
    if (lens === "inbox") await waitFor(() => expect(markThreadSeen).toHaveBeenCalled());
    window.remount();
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    markThreadSeen.mockClear();
    population = snapshot([thread(2_000)]);
    await act(async () => { await window.current.refresh(); });
    if (lens === "inbox") {
      await waitFor(() => expect(markThreadSeen).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-one", seenUpdatedAt: 2_000 }));
    } else {
      expect(window.current.browseMode).toBe("attention");
      expect(markThreadSeen).not.toHaveBeenCalled();
      expect(window.current.selectedThread?.inbox.inInbox).toBe(true);
    }
  });

  it("does not turn an automatic startup selection into manual focus on recovery", async () => {
    let population = snapshot();
    const markThreadSeen = vi.fn();
    const window = createWindow({ readPopulation: async () => population, markThreadSeen });
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    window.remount();
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    population = snapshot([thread(2_000)]);
    await act(async () => { await window.current.refresh(); });
    expect(markThreadSeen).not.toHaveBeenCalled();
  });

  it("does not repeat an already submitted seen write when recovery reads stale unread rows", async () => {
    let population = snapshot([thread(2_000)]);
    const markThreadSeen = vi.fn<NonNullable<DesktopApi["markThreadSeen"]>>(async (request) => ({
      backend: request.backend, threadId: request.threadId, seenAt: Date.now(), seenUpdatedAt: request.seenUpdatedAt,
    }));
    const window = createWindow({ readPopulation: async () => population, markThreadSeen });
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
    act(() => window.current.selectThread(window.current.selectedThread!));
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(1));
    window.remount();
    await waitFor(() => expect(window.current.selectedThread?.inbox.inInbox).toBe(true));
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
    population = snapshot([thread(3_000)]);
    await act(async () => { await window.current.refresh(); });
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(2));
    expect(markThreadSeen).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread-one", seenUpdatedAt: 3_000 });
  });

  it("clears an unrecoverable starting key while main materialization continues exactly once", async () => {
    const directoryKey = "directory:/contrived/project";
    let population = snapshot([]);
    population.directories = [{
      key: directoryKey, kind: "directory", label: "Contrived project", path: "/contrived/project", threadKeys: [], needsAttentionCount: 0,
      launchpad: {
        directoryKey, directoryKind: "directory", directoryLabel: "Contrived project", directoryPath: "/contrived/project",
        backend: "codex", executionMode: "default", workMode: "local", prompt: "Main-owned input", createdAt: 1, updatedAt: 1,
      },
    }];
    const creation = deferred<Awaited<ReturnType<NonNullable<DesktopApi["materializeDirectoryLaunchpad"]>>>>();
    const materializeDirectoryLaunchpad = vi.fn(() => creation.promise);
    const window = createWindow({ readPopulation: async () => population, materializeDirectoryLaunchpad });
    await waitFor(() => expect(window.current.selectedLaunchpad?.directoryKey).toBe(directoryKey));
    const onMaterialized = vi.fn();
    let pending!: Promise<void>;
    act(() => {
      pending = window.current.materializeDirectoryLaunchpad(directoryKey, undefined, undefined, undefined, undefined, undefined, undefined, onMaterialized);
    });
    await waitFor(() => expect(window.current.selectedItemKey).toMatch(/^starting-launchpad:/));
    window.remount();
    await waitFor(() => expect(window.current.loading).toBe(false));
    expect(window.current.selectedItemKey).toBeUndefined();
    expect(window.current.selectedLaunchpad).toBeUndefined();
    population = snapshot([thread()]);
    await act(async () => {
      creation.resolve({ backend: "codex", threadId: "thread-one", executionMode: "default", workMode: "local" });
      await pending;
      await window.current.refresh();
    });
    expect(materializeDirectoryLaunchpad).toHaveBeenCalledTimes(1);
    expect(onMaterialized).toHaveBeenCalledTimes(1);
    expect(window.current.selectedItemKey).toBeUndefined();
    act(() => window.current.selectThread(window.current.threads[0]!));
    await waitFor(() => expect(window.current.selectedThread?.id).toBe("thread-one"));
  });
});
