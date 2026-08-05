import { describe, expect, it, vi } from "vitest";
import type {
  CreateInstanceThreadResult,
  FederationHealthStatus,
  ListFederationInstancesResult,
  ListInstanceProjectsResult,
  MaterializeDirectoryLaunchpadRequest,
  NavigationSnapshot,
  SearchFederationThreadsResult,
} from "@pwragent/shared";
import { createFederationAgentToolsHandler } from "../federation/federation-agent-tools-service";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    readSettings: async () => ({
      federation: {
        instanceLabel: { value: "Local Mac", source: "config" },
        instanceNotes: { value: "Primary dev machine", source: "config" },
      },
    }),
  }),
}));

const context = {
  backend: "codex" as const,
  threadId: "thread-1",
  turnId: "turn-1",
  callId: "call-1",
};

function buildHealth(
  overrides: Partial<FederationHealthStatus> = {},
): FederationHealthStatus {
  return {
    enabled: true,
    role: "gateway",
    status: "listening",
    instanceId: "pwr_local",
    peers: [],
    ...overrides,
  };
}

function buildSnapshot(
  overrides: Partial<NavigationSnapshot> = {},
): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 100,
    unchanged: false,
    threads: [],
    inboxThreadKeys: [],
    directories: [],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
      workMode: "worktree",
      model: "gpt-5.5-codex",
    },
    ...overrides,
  } as NavigationSnapshot;
}

function buildRuntime(overrides: Partial<DesktopFederationRuntime>): () =>
  DesktopFederationRuntime {
  return () => overrides as DesktopFederationRuntime;
}

describe("federation agent tools service", () => {
  it("lists just the local instance when federation is disabled", async () => {
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () => buildHealth({ enabled: false, status: "disabled" }),
      }),
    });

    const response = await handler({
      operation: "list_federation_instances",
      context,
      args: {},
    });

    expect(response.ok).toBe(true);
    const data = (response as { ok: true; data: ListFederationInstancesResult })
      .data;
    expect(data.federationEnabled).toBe(false);
    expect(data.instances).toHaveLength(1);
    expect(data.instances[0]).toMatchObject({
      instanceId: "pwr_local",
      label: "Local Mac",
      isLocal: true,
      status: "connected",
      notes: "Primary dev machine",
    });
  });

  it("lists peers with purpose notes, icons, and status", async () => {
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_studio",
                label: "Studio Mac",
                role: "client",
                status: "connected",
                capabilities: ["thread_navigation", "federated_search"],
                notes: "PwrSnap dev + screen recording",
                icon: "nebula",
              },
              {
                id: "pwr_rack",
                label: "Rack Mini",
                role: "client",
                status: "disconnected",
                capabilities: [],
              },
            ],
          }),
      }),
    });

    const response = await handler({
      operation: "list_federation_instances",
      context,
      args: {},
    });

    const data = (response as { ok: true; data: ListFederationInstancesResult })
      .data;
    expect(data.instances).toHaveLength(3);
    expect(data.instances[1]).toMatchObject({
      instanceId: "pwr_studio",
      isLocal: false,
      status: "connected",
      notes: "PwrSnap dev + screen recording",
      icon: "nebula",
    });
    expect(data.instances[2]).toMatchObject({
      instanceId: "pwr_rack",
      status: "disconnected",
    });
  });

  it("routes list_instance_projects to the remote backend and filters unlinked", async () => {
    const getNavigationSnapshot = vi.fn(async () =>
      buildSnapshot({
        directories: [
          {
            key: "dir:/Users/op/pwrsnap",
            kind: "directory",
            label: "PwrSnap",
            path: "/Users/op/pwrsnap",
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad: {
              backend: "codex",
              executionMode: "default",
              workMode: "worktree",
              model: "gpt-5.5-codex",
              directoryKey: "dir:/Users/op/pwrsnap",
              directoryKind: "directory",
              directoryLabel: "PwrSnap",
              prompt: "",
              createdAt: 1,
              updatedAt: 2,
            },
          },
          {
            key: "unlinked",
            kind: "unlinked",
            label: "Unlinked",
            threadKeys: [],
            needsAttentionCount: 0,
          },
        ] as NavigationSnapshot["directories"],
      }),
    );
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_studio",
                label: "Studio Mac",
                role: "client",
                status: "connected",
                capabilities: ["thread_navigation"],
              },
            ],
          }),
        remoteBackend: (() => ({ getNavigationSnapshot })) as never,
      }),
    });

    const response = await handler({
      operation: "list_instance_projects",
      context,
      args: { instanceId: "pwr_studio" },
    });

    expect(getNavigationSnapshot).toHaveBeenCalled();
    const data = (response as { ok: true; data: ListInstanceProjectsResult })
      .data;
    expect(data).toMatchObject({
      instanceId: "pwr_studio",
      isLocal: false,
    });
    expect(data.projects).toEqual([
      {
        key: "dir:/Users/op/pwrsnap",
        label: "PwrSnap",
        kind: "directory",
        path: "/Users/op/pwrsnap",
        hasLaunchpad: true,
        backend: "codex",
        workMode: "worktree",
        model: "gpt-5.5-codex",
        executionMode: "default",
      },
    ]);
  });

  it("returns not_found for an unknown instance", async () => {
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () => buildHealth(),
      }),
    });

    const response = await handler({
      operation: "list_instance_projects",
      context,
      args: { instanceId: "pwr_ghost" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("returns peer_unavailable for a disconnected instance", async () => {
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_rack",
                label: "Rack Mini",
                role: "client",
                status: "disconnected",
                capabilities: [],
              },
            ],
          }),
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: { instanceId: "pwr_rack", projectKey: "dir:/repo" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "peer_unavailable" },
    });
  });

  it("creates a local thread with merged launchpad settings and an initial input", async () => {
    const materializeDirectoryLaunchpad = vi.fn(
      async (request: MaterializeDirectoryLaunchpadRequest) => ({
        backend: "codex" as const,
        threadId: "thread-9",
        executionMode:
          request.launchpad?.executionMode ?? ("default" as const),
        workMode: request.launchpad?.workMode ?? ("worktree" as const),
        turnId: "turn-9",
      }),
    );
    const getNavigationSnapshot = vi.fn(async () =>
      buildSnapshot({
        directories: [
          {
            key: "dir:/Users/op/pwragent",
            kind: "directory",
            label: "PwrAgent",
            path: "/Users/op/pwragent",
            threadKeys: [],
            needsAttentionCount: 0,
          },
        ] as NavigationSnapshot["directories"],
      }),
    );
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({
          getNavigationSnapshot,
          materializeDirectoryLaunchpad,
        })) as never,
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: {
        instanceId: "pwr_local",
        projectKey: "dir:/Users/op/pwragent",
        input: "Fix the recorder crash",
        model: "gpt-5.5-codex-max",
        executionMode: "full-access",
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "dir:/Users/op/pwragent",
      launchpad: expect.objectContaining({
        backend: "codex",
        executionMode: "full-access",
        workMode: "worktree",
        model: "gpt-5.5-codex-max",
        directoryKey: "dir:/Users/op/pwragent",
        directoryLabel: "PwrAgent",
        prompt: "",
      }),
      input: [{ type: "text", text: "Fix the recorder crash" }],
    });
    const data = (response as { ok: true; data: CreateInstanceThreadResult })
      .data;
    expect(data).toMatchObject({
      instanceId: "pwr_local",
      isLocal: true,
      threadId: "thread-9",
      executionMode: "full-access",
      turnId: "turn-9",
    });
    expect(data.threadLink).toContain("pwragent://thread/thread-9");
  });

  it("merges local and peer results in search_federation_threads", async () => {
    const localThread = {
      id: "thread-local",
      title: "Recorder crash on stop",
      source: "codex" as const,
      linkedDirectories: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const remoteThread = {
      id: "thread-remote",
      title: "Recorder crash investigation",
      source: "codex" as const,
      linkedDirectories: [],
      createdAt: 1,
      updatedAt: 3,
    };
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({
          listThreads: async () => ({
            backend: "all",
            fetchedAt: 10,
            threads: [localThread],
          }),
        })) as never,
        connectedPeerTargets: () => [
          {
            target: { scope: "remote", instanceId: "pwr_studio" },
            label: "Studio Mac",
            capabilities: ["federated_search"],
          },
        ],
        remoteBackend: (() => ({
          listThreads: async () => ({
            backend: "all",
            fetchedAt: 10,
            threads: [remoteThread],
          }),
        })) as never,
      }),
    });

    const response = await handler({
      operation: "search_federation_threads",
      context,
      args: { query: "recorder crash" },
    });

    const data = (response as { ok: true; data: SearchFederationThreadsResult })
      .data;
    expect(data.results).toHaveLength(2);
    const local = data.results.find((entry) => entry.isLocal);
    const remote = data.results.find((entry) => !entry.isLocal);
    expect(local).toMatchObject({
      instanceId: "pwr_local",
      instanceLabel: "Local Mac",
      threadId: "thread-local",
    });
    expect(local?.threadLink).toContain("pwragent://thread/thread-local");
    expect(remote).toMatchObject({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
      threadId: "thread-remote",
    });
    expect(remote?.threadLink).toBeUndefined();
    expect(data.searchedInstances).toEqual([
      { instanceId: "pwr_local", instanceLabel: "Local Mac", resultCount: 1 },
      { instanceId: "pwr_studio", instanceLabel: "Studio Mac", resultCount: 1 },
    ]);
  });

  it("scopes search_federation_threads to one peer and skips local", async () => {
    const localListThreads = vi.fn();
    const handler = createFederationAgentToolsHandler({
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_studio",
                label: "Studio Mac",
                role: "client",
                status: "connected",
                capabilities: ["federated_search"],
              },
            ],
          }),
        localBackend: (() => ({ listThreads: localListThreads })) as never,
        connectedPeerTargets: () => [
          {
            target: { scope: "remote", instanceId: "pwr_studio" },
            label: "Studio Mac",
            capabilities: ["federated_search"],
          },
        ],
        remoteBackend: (() => ({
          listThreads: async () => ({
            backend: "all",
            fetchedAt: 10,
            threads: [],
          }),
        })) as never,
      }),
    });

    const response = await handler({
      operation: "search_federation_threads",
      context,
      args: { query: "recorder crash", instanceId: "pwr_studio" },
    });

    expect(localListThreads).not.toHaveBeenCalled();
    const data = (response as { ok: true; data: SearchFederationThreadsResult })
      .data;
    expect(data.searchedInstances).toEqual([
      { instanceId: "pwr_studio", instanceLabel: "Studio Mac", resultCount: 0 },
    ]);
  });
});
