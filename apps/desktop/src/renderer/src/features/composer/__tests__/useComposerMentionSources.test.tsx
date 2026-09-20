import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationTarget, NavigationQueryPage, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import {
  resetComposerMentionSourcesCache,
  useComposerMentionSources,
} from "../useComposerMentionSources";

beforeEach(resetComposerMentionSourcesCache);

describe("bounded composer mention sources", () => {
  it("modern mentions never read snapshots and can find a thread outside the initial page", async () => {
    const threads = Array.from({ length: 1_001 }, (_, index): NavigationThreadSummary => ({
      id: `thread-${index}`,
      source: "codex",
      title: `Unique project ${index}`,
      titleSource: "explicit",
      linkedDirectories: [],
      inbox: { inInbox: false },
    }));
    const getNavigationQueryPage = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(
      async (request) => navigationQueryFixture(request, { threads }),
    );
    const getNavigationSnapshot = vi.fn(() => { throw new Error("Retired collection"); });
    const desktopApi: DesktopApi = { getNavigationQueryPage, getNavigationSnapshot };
    const { result } = renderHook(() => useComposerMentionSources({ desktopApi }));
    expect(getNavigationQueryPage).not.toHaveBeenCalled();
    act(() => result.current.ensureLoaded());
    await waitFor(() => expect(result.current.threads).toHaveLength(10));
    expect(result.current.threads.some((thread) => thread.id === "thread-1000")).toBe(false);
    act(() => result.current.ensureLoaded("Unique project 1000"));
    await waitFor(() => expect(result.current.settledQuery).toBe("unique project 1000"));
    expect(result.current.threads.map((thread) => thread.id)).toEqual(["thread-1000"]);
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
    expect(getNavigationQueryPage.mock.calls.every(([request]) => request.pageSize === 10)).toBe(true);
  });

  it("releases both query interests when the picker closes", async () => {
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      getNavigationQueryPage: async (request) => navigationQueryFixture(request, {}),
      releaseNavigationQuery,
    };
    const { result } = renderHook(() => useComposerMentionSources({ desktopApi }));
    act(() => result.current.ensureLoaded("query"));
    await waitFor(() => expect(result.current.settledQuery).toBe("query"));
    act(() => result.current.release());
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(2);
  });

  function ownerPage(request: NavigationQueryRequest): NavigationQueryPage {
    const owner = request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : "local";
    return navigationQueryFixture(request, {
      directories: [{ key: owner, kind: "directory", label: `microapps-${owner}`, path: `/${owner}/microapps` }],
      threads: [{ id: owner, source: "codex", title: `microapps-${owner}`, titleSource: "explicit",
        linkedDirectories: [], inbox: { inInbox: false } }],
    });
  }

  it.each(["", "microapps"])("routes directories to the owner but keeps thread query %j local", async (query) => {
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => ownerPage(request));
    const desktopApi: DesktopApi = { getNavigationQueryPage };
    const target: FederationTarget = { scope: "remote", instanceId: "m2-max" };
    const { result, rerender } = renderHook(({ federationTarget }) => useComposerMentionSources({
      desktopApi, federationTarget,
    }), { initialProps: { federationTarget: target } });
    expect(getNavigationQueryPage).not.toHaveBeenCalled();
    act(() => result.current.ensureLoaded(query));
    await waitFor(() => expect(result.current.settledQuery).toBe(query));
    expect(result.current.directories.map((row) => row.path)).toEqual(["/m2-max/microapps"]);
    expect(result.current.threads.map((row) => row.id)).toEqual(["local"]);
    expect(getNavigationQueryPage).toHaveBeenCalledTimes(2);
    expect(getNavigationQueryPage.mock.calls[0]![0].federationTarget).toEqual(target);
    expect(getNavigationQueryPage.mock.calls[1]![0].federationTarget).toBeUndefined();
    rerender({ federationTarget: { ...target } });
    act(() => result.current.release());
    act(() => result.current.ensureLoaded(query));
    expect(getNavigationQueryPage).toHaveBeenCalledTimes(2);
  });

  it("isolates local and remote caches even when the bridge and query are identical", async () => {
    const getNavigationQueryPage = vi.fn(async (request: NavigationQueryRequest) => ownerPage(request));
    const desktopApi: DesktopApi = { getNavigationQueryPage };
    const { result, rerender } = renderHook(({ federationTarget }: { federationTarget?: FederationTarget }) =>
      useComposerMentionSources({ desktopApi, federationTarget }), { initialProps: {} });
    for (const owner of ["local", "m2-max", "other-peer", "local", "m2-max"]) {
      rerender({ federationTarget: owner === "local" ? undefined : { scope: "remote", instanceId: owner } });
      act(() => result.current.ensureLoaded("microapps"));
      await waitFor(() => expect(result.current.directories.map((row) => row.path)).toEqual([`/${owner}/microapps`]));
      expect(result.current.threads.map((row) => row.id)).toEqual(["local"]);
    }
    expect(getNavigationQueryPage).toHaveBeenCalledTimes(6);
  });

  it("clears the previous owner's rows while the next owner is pending or unavailable", async () => {
    let rejectRemote!: (error: Error) => void;
    const desktopApi: DesktopApi = {
      getNavigationQueryPage: (request) => request.federationTarget?.scope === "remote"
        ? new Promise((_resolve, reject) => { rejectRemote = reject; })
        : Promise.resolve(ownerPage(request)),
    };
    const { result, rerender } = renderHook(({ federationTarget }: { federationTarget?: FederationTarget }) =>
      useComposerMentionSources({ desktopApi, federationTarget }), { initialProps: {} });
    act(() => result.current.ensureLoaded("microapps"));
    await waitFor(() => expect(result.current.directories).toHaveLength(1));
    rerender({ federationTarget: { scope: "remote", instanceId: "offline-peer" } });
    expect(result.current.directories).toEqual([]);
    expect(result.current.threads).toEqual([]);
    expect(result.current.settledQuery).toBeUndefined();
    await act(async () => rejectRemote(new Error("Peer disconnected")));
    expect(result.current.directories).toEqual([]);
    expect(result.current.threads).toEqual([]);
  });

  it("ignores a late response from an owner after switching away", async () => {
    const pending: Array<() => void> = [];
    const releaseNavigationQuery = vi.fn(async () => undefined);
    const desktopApi: DesktopApi = {
      getNavigationQueryPage: (request) => request.federationTarget?.scope === "remote"
        ? new Promise((resolve) => pending.push(() => resolve(ownerPage(request))))
        : Promise.resolve(ownerPage(request)),
      releaseNavigationQuery,
    };
    const { result, rerender } = renderHook(({ federationTarget }: { federationTarget?: FederationTarget }) =>
      useComposerMentionSources({ desktopApi, federationTarget }),
    { initialProps: { federationTarget: { scope: "remote", instanceId: "slow-peer" } } });
    act(() => result.current.ensureLoaded("microapps"));
    rerender({ federationTarget: undefined });
    await waitFor(() => expect(result.current.directories.map((row) => row.path)).toEqual(["/local/microapps"]));
    await act(async () => pending.forEach((resolve) => resolve()));
    expect(result.current.directories.map((row) => row.path)).toEqual(["/local/microapps"]);
    expect(releaseNavigationQuery).toHaveBeenCalledTimes(2);
  });

});
