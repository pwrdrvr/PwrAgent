import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AgentEvent,
  FederationRemoteTarget,
  NavigationDirectorySummary,
  NavigationQueryRequest,
  NavigationSnapshot,
} from "@pwragent/shared";
import { useMemo } from "react";
import { useComposerDraftStore } from "../../features/composer/useComposerDraftStore";
import { navigationOwnerApiFixture, type NavigationOwnerFixtureApi as DesktopApi } from "../../test/navigation-owner-api-fixture";
import { describe, expect, it, vi } from "vitest";
import type { ProjectIdentity } from "../federation-project-match";
import { useThreadNavigation as useRealThreadNavigation } from "../useThreadNavigation";

function useThreadNavigation(api: DesktopApi) {
  const composerDraftStore = useComposerDraftStore();
  const ownerApi = useMemo(() => navigationOwnerApiFixture(api), [api]);
  return useRealThreadNavigation(ownerApi, { composerDraftStore });
}

const defaults = { backend: "codex" as const, executionMode: "default" as const };
const workspace: NavigationDirectorySummary = {
  key: "workspace:new-thread", kind: "workspace", label: "Workspaces", threadKeys: [], needsAttentionCount: 0,
};
const projectOn = (instanceId: string): NavigationDirectorySummary => ({
  key: `directory:/${instanceId}/ProjectA`, kind: "directory", label: "ProjectA",
  path: `/${instanceId}/ProjectA`, threadKeys: [], needsAttentionCount: 0,
});
const localProject: ProjectIdentity = { kind: "directory", label: "ProjectA", path: "/Users/me/ProjectA" };
const remote = (instanceId: string): FederationRemoteTarget => ({ scope: "remote", instanceId });
const PEERS = ["studio", "tower", "laptop"] as const;

/**
 * Peers whose directory sets the test changes, a desktop API that counts each
 * peer's directory-index reads, and the agent-event channel the window hears.
 */
function federatedPeers(initial: Record<string, NavigationDirectorySummary[]>) {
  const directoriesByPeer = new Map(Object.entries(initial));
  const loadingPeers = new Set<string>();
  /** Main's directory-set watch generation per peer; absent means unwatched. */
  const watchGenerations = new Map<string, number>();
  const indexReads: string[] = [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const snapshot = (target?: FederationRemoteTarget): NavigationSnapshot => ({
    backend: "all", fetchedAt: 1, unchanged: false, inboxThreadKeys: [], threads: [],
    directories: target ? directoriesByPeer.get(target.instanceId) ?? [] : [],
    launchpadDefaults: defaults, ...(target ? { federationTarget: target } : {}),
  });
  const getNavigationQueryPage = async (request: NavigationQueryRequest) => {
    const target = request.federationTarget?.scope === "remote" ? request.federationTarget : undefined;
    if (target && request.query.kind === "directory-index") indexReads.push(target.instanceId);
    const page = navigationQueryFixture(request, snapshot(target));
    return target && loadingPeers.has(target.instanceId)
      ? { ...page, coverage: { state: "checking" as const } } : page;
  };
  const ensureDirectoryLaunchpad = vi.fn<NonNullable<DesktopApi["ensureDirectoryLaunchpad"]>>(async (request) => ({
    launchpad: {
      directoryKey: request.directoryKey, directoryKind: request.directoryKind,
      directoryLabel: request.directoryLabel, directoryPath: request.directoryPath,
      backend: "codex", executionMode: "default", prompt: "", workMode: "local",
      federationTarget: request.federationTarget, createdAt: 1, updatedAt: 2,
    },
    defaults,
  }));
  const desktopApi: DesktopApi = {
    ensureDirectoryLaunchpad,
    readPopulation: async (request) => snapshot(
      request?.federationTarget?.scope === "remote" ? request.federationTarget : undefined,
    ),
    getNavigationQueryPage,
    watchFederatedDirectorySet: async ({ instanceId }) => {
      const generation = watchGenerations.get(instanceId);
      return { watch: generation === undefined ? null : { generation } };
    },
    onAgentEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    desktopApi,
    directoriesByPeer,
    ensureDirectoryLaunchpad,
    loadingPeers,
    watchGenerations,
    emit: (instanceId: string, method: string, params: Record<string, unknown> = {}) => {
      const event = {
        backend: "codex", federationTarget: remote(instanceId), notification: { method, params },
      } as AgentEvent;
      for (const listener of listeners) listener(event);
    },
    /** Reads since the previous call, by peer, in the order they ran. */
    takeIndexReads: () => indexReads.splice(0),
  };
}

describe("project-aware machine menus: directory-index reads", () => {
  it("re-reads a peer's index only to prove absence, after a change, or to open", async () => {
    const peers = federatedPeers({
      studio: [workspace, projectOn("studio")],
      tower: [workspace, projectOn("tower")],
      laptop: [workspace],
    });
    const { result } = renderHook(() => useThreadNavigation(peers.desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));
    peers.takeIndexReads();
    // Directory-index reads per step, compared once at the end so a
    // regression prints the whole sequence rather than its first step.
    const reads: Record<string, string[]> = {};
    const step = (name: string) => {
      reads[name] = peers.takeIndexReads().sort();
    };

    // One menu opening asks every available peer, as useFederationProjectStates does.
    const openMenu = async (): Promise<boolean[]> => {
      let states: boolean[] = [];
      await act(async () => {
        states = await Promise.all(PEERS.map((instanceId) =>
          result.current.federatedTargetHasProject(remote(instanceId), localProject)));
      });
      return states;
    };

    // First opening: nothing is known yet, so every peer is read once.
    expect(await openMenu()).toEqual([true, true, false]);
    step("first open");

    // Reopening: a cached index proves the project is there. It cannot prove
    // that it is still missing, because registering a launchpad on the
    // peer emits no event. Only that peer is asked again.
    expect(await openMenu()).toEqual([true, true, false]);
    step("reopen");

    // Choosing a machine from the chip validates against fresh owner data.
    let plan: Awaited<ReturnType<typeof result.current.planLaunchpadMachineRetarget>>;
    await act(async () => {
      plan = await result.current.planLaunchpadMachineRetarget(localProject, "studio", "Studio Mac");
    });
    expect(plan!).toMatchObject({ directoryKey: projectOn("studio").key });
    await act(async () => {
      await plan!.open();
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: projectOn("studio").key, federationTarget: remote("studio"),
    });
    step("chip selection");

    // So does choosing one from the sidebar project menu.
    await act(async () => {
      await result.current.openFederatedProjectLaunchpad(remote("tower"), localProject, "Tower");
    });
    expect(result.current.selectedLaunchpad).toMatchObject({
      directoryKey: projectOn("tower").key, federationTarget: remote("tower"),
    });
    step("sidebar selection");

    // The laptop gains the project silently. Absence was never cached, so
    // the next opening finds it, and the one after that reads nothing.
    peers.directoriesByPeer.set("laptop", [workspace, projectOn("laptop")]);
    expect(await openMenu()).toEqual([true, true, true]);
    step("open after a silent add");
    expect(await openMenu()).toEqual([true, true, true]);
    step("open, all present");

    // A peer status change drops what that peer told us.
    act(() => peers.emit("studio", "federation/peerStatus/changed", { instanceId: "studio", status: "connected" }));
    expect(await openMenu()).toEqual([true, true, true]);
    step("open after a status change");

    // An event that can change the peer's directory set does too.
    peers.directoriesByPeer.set("tower", [workspace]);
    act(() => peers.emit("tower", "navigation/directory/removed", { directoryKey: projectOn("tower").key }));
    expect(await openMenu()).toEqual([true, false, true]);
    step("open after a directory removal");

    // A peer's turn activity does not touch its directory set.
    act(() => peers.emit("studio", "turn/completed", { threadId: "thread-1" }));
    act(() => peers.emit("laptop", "navigation/directoryGitStatus/updated", { directoryKey: projectOn("laptop").key }));
    expect(await openMenu()).toEqual([true, false, true]);
    step("open after turn activity");

    expect(reads).toEqual({
      "first open": ["laptop", "studio", "tower"],
      "reopen": ["laptop"],
      "chip selection": ["studio"],
      "sidebar selection": ["tower"],
      "open after a silent add": ["laptop"],
      "open, all present": [],
      "open after a status change": ["studio"],
      "open after a directory removal": ["tower"],
      // The removal left the tower without the project, so it is asked again.
      "open after turn activity": ["tower"],
    });
  });

  it("trusts absence from a peer that announces its directory set", async () => {
    const peers = federatedPeers({
      studio: [workspace, projectOn("studio")],
      tower: [workspace],
      laptop: [workspace],
    });
    // The tower and the laptop announce; the studio is an older build.
    peers.watchGenerations.set("tower", 1);
    peers.watchGenerations.set("laptop", 1);
    const { result } = renderHook(() => useThreadNavigation(peers.desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));
    peers.takeIndexReads();
    const reads: Record<string, string[]> = {};
    const step = (name: string) => {
      reads[name] = peers.takeIndexReads().sort();
    };
    const openMenu = async (): Promise<boolean[]> => {
      let states: boolean[] = [];
      await act(async () => {
        states = await Promise.all(PEERS.map((instanceId) =>
          result.current.federatedTargetHasProject(remote(instanceId), localProject)));
      });
      return states;
    };

    expect(await openMenu()).toEqual([true, false, false]);
    step("first open");
    expect(await openMenu()).toEqual([true, false, false]);
    step("reopen");

    // The laptop adds the project and announces it.
    peers.directoriesByPeer.set("laptop", [workspace, projectOn("laptop")]);
    peers.watchGenerations.set("laptop", 2);
    expect(await openMenu()).toEqual([true, false, true]);
    step("open after an announced change");

    // The tower's watch lapses (reconnect, re-sent subscription): unknown again.
    peers.watchGenerations.delete("tower");
    expect(await openMenu()).toEqual([true, false, true]);
    step("open while the tower's watch is not acknowledged");
    peers.watchGenerations.set("tower", 5);
    expect(await openMenu()).toEqual([true, false, true]);
    step("open after the tower acknowledges");
    expect(await openMenu()).toEqual([true, false, true]);
    step("open, all known");

    // Choosing a machine still reads the owner afresh.
    await act(async () => {
      await result.current.openFederatedProjectLaunchpad(remote("laptop"), localProject, "Laptop");
    });
    step("sidebar selection");

    // The laptop drops the project and announces it: no stale "present".
    peers.directoriesByPeer.set("laptop", [workspace]);
    peers.watchGenerations.set("laptop", 3);
    expect(await openMenu()).toEqual([true, false, false]);
    step("open after an announced removal");

    expect(reads).toEqual({
      "first open": ["laptop", "studio", "tower"],
      "reopen": [],
      "open after an announced change": ["laptop"],
      "open while the tower's watch is not acknowledged": ["tower"],
      "open after the tower acknowledges": ["tower"],
      "open, all known": [],
      "sidebar selection": ["laptop"],
      "open after an announced removal": ["laptop"],
    });
  });

  it("shares one read between overlapping checks of the same peer", async () => {
    const peers = federatedPeers({ studio: [workspace] });
    const { result } = renderHook(() => useThreadNavigation(peers.desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));
    peers.takeIndexReads();

    // The sidebar menu and the composer chip can ask about different
    // projects on one peer at once; one index answers both.
    const other: ProjectIdentity = { kind: "directory", label: "ProjectB", path: "/Users/me/ProjectB" };
    let states: boolean[] = [];
    await act(async () => {
      states = await Promise.all([
        result.current.federatedTargetHasProject(remote("studio"), localProject),
        result.current.federatedTargetHasProject(remote("studio"), other),
      ]);
    });
    expect(states).toEqual([false, false]);
    expect(peers.takeIndexReads()).toEqual(["studio"]);
  });

  it("never caches an index the peer is still loading", async () => {
    const peers = federatedPeers({ studio: [workspace, projectOn("studio")] });
    peers.loadingPeers.add("studio");
    const { result } = renderHook(() => useThreadNavigation(peers.desktopApi));
    await waitFor(() => expect(result.current.loading).toBe(false));
    peers.takeIndexReads();

    // A half-loaded owner is unknown, never "No project": the check fails,
    // and the menu reads a failed check as present.
    await act(async () => {
      await expect(result.current.federatedTargetHasProject(remote("studio"), localProject))
        .rejects.toThrow();
    });
    expect(peers.takeIndexReads()).toEqual(["studio"]);

    peers.loadingPeers.delete("studio");
    let present = false;
    await act(async () => {
      present = await result.current.federatedTargetHasProject(remote("studio"), localProject);
    });
    expect(present).toBe(true);
    expect(peers.takeIndexReads()).toEqual(["studio"]);
  });
});
