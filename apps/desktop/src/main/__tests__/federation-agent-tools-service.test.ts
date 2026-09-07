import { describe, expect, it, vi } from "vitest";
import type {
  CreateInstanceThreadResult,
  FederationHealthStatus,
  FederationHostInfo,
  FederationLoadStatus,
  ListFederationInstancesResult,
  ListInstanceProjectsResult,
  MaterializeDirectoryLaunchpadRequest,
  NavigationSnapshot,
  NavigationQueryRequest,
  NavigationQueryPage,
  SearchFederationThreadsResult,
} from "@pwragent/shared";
import { projectNavigationQuery } from "../app-server/navigation-query-projection";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";
import { createFederationAgentToolsHandler } from "../federation/federation-agent-tools-service";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";

const localHostInfo: FederationHostInfo = {
  platform: "darwin",
  osVersion: "25.5.0",
  hostname: "local-mac",
  arch: "arm64",
  cpuCount: 16,
  memoryBytes: 68_719_476_736,
  diskFreeBytes: 512_000_000_000,
  machineId: "mach_local",
};


vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => ({
    readFederationConfig: () => ({
      instanceLabel: "Local Mac",
      instanceNotes: "Primary dev machine",
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
  const wrap = (backend: FederationBackendOperations & { readPopulation?: () => Promise<NavigationSnapshot> }): FederationBackendOperations => ({
    ...backend,
    getNavigationSnapshot: async () => { throw new Error("Legacy navigation is forbidden"); },
    getNavigationQueryPage: async (request: NavigationQueryRequest): Promise<NavigationQueryPage> => {
      const population = await backend.readPopulation!();
      const projected = projectNavigationQuery({ index: population, request });
      const offset = Number(request.cursor ?? 0);
      const limit = request.pageSize ?? 100;
      const directoryQuery = request.query.kind === "directory-index";
      const total = directoryQuery ? projected.directories.length : projected.entries.length;
      return { ...projected, protocol: 2, ownerEpoch: "owner", generation: "fixture", countsRevision: "revision",
        entries: directoryQuery ? [] : projected.entries.slice(offset, offset + limit),
        directories: directoryQuery ? projected.directories.slice(offset, offset + limit) : [],
        complete: offset + limit >= total, ...(offset + limit < total ? { nextCursor: String(offset + limit) } : {}) };
    },
    getNavigationLaunchpadConfig: async (request) => {
      const population = await backend.readPopulation!();
      return { protocol: 2, revision: "config", directoryKey: request.directoryKey, defaults: population.launchpadDefaults,
        launchpad: population.directories.find((directory) => directory.key === request.directoryKey)?.launchpad };
    },
    getNavigationSelectedDetail: async (request) => {
      const population = await backend.readPopulation!();
      const thread = population.threads.find((thread) => thread.source === request.ref.backend && thread.id === request.ref.threadId);
      return { protocol: 2, revision: "detail", ref: request.ref, readiness: "ready", identity: thread ? "present" : "unresolved", thread };
    },
  });
  return () => ({ ...overrides,
    ...(overrides.localBackend ? { localBackend: () => wrap(overrides.localBackend!()) } : {}),
    ...(overrides.remoteBackend ? { remoteBackend: (target) => wrap(overrides.remoteBackend!(target)),
      remoteNavigationQueryPage: (target, request) => wrap(overrides.remoteBackend!(target)).getNavigationQueryPage!(request),
      remoteNavigationLaunchpadConfig: (target, request) => wrap(overrides.remoteBackend!(target)).getNavigationLaunchpadConfig!(request),
    } : {}),
  }) as DesktopFederationRuntime;
}

describe("federation agent tools service", () => {
  it("lists just the local instance when federation is disabled", async () => {
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
    expect(data.totalCount).toBe(1);
    expect(data.nextCursor).toBeUndefined();
    expect(data.instances[0]).toMatchObject({
      instanceId: "pwr_local",
      label: "Local Mac",
      isLocal: true,
      status: "connected",
      notes: "Primary dev machine",
      host: {
        platform: "darwin",
        cpuCount: 16,
        machineId: "mach_local",
      },
    });
  });

  it("lists peers with purpose notes, icons, and status", async () => {
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
                celestialIcon: "ringed-planet",
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
      icon: "ringed-planet",
    });
    expect(data.instances[2]).toMatchObject({
      instanceId: "pwr_rack",
      status: "disconnected",
    });
  });

  it("pages the instance list with single-use continuation tokens", async () => {
    const peers = Array.from({ length: 30 }, (_, index) => ({
      id: `pwr_peer_${index}`,
      label: `Peer ${index}`,
      role: "client" as const,
      status: "connected" as const,
      capabilities: [],
    }));
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () => buildHealth({ peers }),
      }),
    });

    const first = await handler({
      operation: "list_federation_instances",
      context,
      args: {},
    });
    const firstData = (first as { ok: true; data: ListFederationInstancesResult })
      .data;
    expect(firstData.instances).toHaveLength(25);
    expect(firstData.totalCount).toBe(31);
    expect(firstData.nextCursor).toBeDefined();

    const second = await handler({
      operation: "list_federation_instances",
      context,
      args: { cursor: firstData.nextCursor! },
    });
    const secondData = (second as { ok: true; data: ListFederationInstancesResult })
      .data;
    expect(secondData.instances).toHaveLength(6);
    expect(secondData.totalCount).toBe(31);
    expect(secondData.nextCursor).toBeUndefined();
    expect([
      ...firstData.instances.map((instance) => instance.instanceId),
      ...secondData.instances.map((instance) => instance.instanceId),
    ]).toHaveLength(31);

    // Tokens are single-use: replaying the consumed cursor fails.
    const replay = await handler({
      operation: "list_federation_instances",
      context,
      args: { cursor: firstData.nextCursor! },
    });
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  it("attaches live load readings only to instances that answer includeLoad", async () => {
    const localLoad: FederationLoadStatus = {
      loadAvg1: 0.5,
      loadAvg5: 0.4,
      loadAvg15: 0.3,
      availableMemoryBytes: 32_000_000_000,
      diskFreeBytes: 400_000_000_000,
      sampledAt: 1_000,
    };
    const studioLoad: FederationLoadStatus = {
      loadAvg1: 6.5,
      loadAvg5: 5.0,
      loadAvg15: 4.25,
      availableMemoryBytes: 2_000_000_000,
      sampledAt: 1_050,
    };
    const remoteBackend = vi.fn(
      (target: { instanceId: string }) =>
        ({
          getLoadStatus: async () => {
            if (target.instanceId === "pwr_studio") {
              return studioLoad;
            }
            throw new Error("Federation request timed out: backend.getLoadStatus");
          },
        }) as unknown as ReturnType<DesktopFederationRuntime["remoteBackend"]>,
    );
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      collectLoadStatus: async () => localLoad,
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
              {
                id: "pwr_slow",
                label: "Slow Mini",
                role: "client",
                status: "connected",
                capabilities: ["thread_navigation"],
              },
              {
                id: "pwr_nocap",
                label: "Locked-Down Box",
                role: "client",
                status: "connected",
                capabilities: ["federated_search"],
              },
              {
                id: "pwr_offline",
                label: "Offline Mini",
                role: "client",
                status: "disconnected",
                capabilities: ["thread_navigation"],
              },
            ],
          }),
        remoteBackend:
          remoteBackend as unknown as DesktopFederationRuntime["remoteBackend"],
      }),
    });

    const response = await handler({
      operation: "list_federation_instances",
      context,
      args: { includeLoad: true },
    });

    expect(response.ok).toBe(true);
    const data = (response as { ok: true; data: ListFederationInstancesResult })
      .data;
    const byId = new Map(
      data.instances.map((instance) => [instance.instanceId, instance]),
    );
    expect(byId.get("pwr_local")?.load).toEqual(localLoad);
    expect(byId.get("pwr_studio")?.load).toEqual(studioLoad);
    // Timed-out, capability-less, and disconnected peers degrade to no
    // load block — the listing itself never fails.
    expect(byId.get("pwr_slow")?.load).toBeUndefined();
    expect(byId.get("pwr_nocap")?.load).toBeUndefined();
    expect(byId.get("pwr_offline")?.load).toBeUndefined();
    // Only load-eligible peers are queried at all.
    expect(remoteBackend.mock.calls.map(([target]) => target.instanceId).sort())
      .toEqual(["pwr_slow", "pwr_studio"]);
  });

  it("does not fan out load queries unless includeLoad is set", async () => {
    const remoteBackend = vi.fn();
    const collectLoadStatus = vi.fn();
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      collectLoadStatus,
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
        remoteBackend:
          remoteBackend as unknown as DesktopFederationRuntime["remoteBackend"],
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
    expect(data.instances.every((instance) => instance.load === undefined))
      .toBe(true);
    expect(remoteBackend).not.toHaveBeenCalled();
    expect(collectLoadStatus).not.toHaveBeenCalled();
  });

  it("rejects an unknown instance-list cursor", async () => {
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () => buildHealth(),
      }),
    });

    const response = await handler({
      operation: "list_federation_instances",
      context,
      args: { cursor: "cursor-from-another-life" },
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments" },
    });
  });

  it("filters the instance list by query across labels, notes, and host facts", async () => {
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_studio",
                label: "Studio Mac",
                role: "client",
                status: "connected",
                capabilities: [],
                host: { platform: "darwin", hostname: "studio" },
              },
              {
                id: "pwr_rack",
                label: "Rack Mini",
                role: "client",
                status: "connected",
                capabilities: [],
                notes: "long-running agents",
                host: { platform: "linux", hostname: "rack-01" },
              },
            ],
          }),
      }),
    });

    const byPlatform = await handler({
      operation: "list_federation_instances",
      context,
      args: { query: "linux" },
    });
    const platformData = (
      byPlatform as { ok: true; data: ListFederationInstancesResult }
    ).data;
    expect(platformData.totalCount).toBe(1);
    expect(platformData.instances[0]).toMatchObject({ instanceId: "pwr_rack" });

    const byNotes = await handler({
      operation: "list_federation_instances",
      context,
      args: { query: "long-running" },
    });
    const notesData = (
      byNotes as { ok: true; data: ListFederationInstancesResult }
    ).data;
    expect(notesData.instances.map((instance) => instance.instanceId)).toEqual([
      "pwr_rack",
    ]);
  });

  it("routes list_instance_projects to the remote backend and filters unlinked", async () => {
    const readPopulation = vi.fn(async () =>
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
          {
            key: "dir:/Users/op/pwrgit",
            kind: "directory",
            label: "PwrGit",
            path: "/Users/op/pwrgit",
            threadKeys: [],
            needsAttentionCount: 0,
          },
        ] as NavigationSnapshot["directories"],
      }),
    );
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
        remoteBackend: (() => ({ readPopulation })) as never,
      }),
    });

    const response = await handler({
      operation: "list_instance_projects",
      context,
      args: { instanceId: "pwr_studio" },
    });

    expect(readPopulation).toHaveBeenCalled();
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
      },
      {
        key: "dir:/Users/op/pwrgit",
        label: "PwrGit",
        kind: "directory",
        path: "/Users/op/pwrgit",
        hasLaunchpad: false,
      },
    ]);
  });

  it("returns not_found for an unknown instance", async () => {
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
    const readPopulation = vi.fn(async () =>
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
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      resolveSourceTurnAttachments: async () => [{
        type: "localImage",
        name: "source.png",
        path: "/pwragent/staged/source.png",
      }],
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({
          readPopulation,
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
        tokenMiserEnabled: false,
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      {
        directoryKey: "dir:/Users/op/pwragent",
        launchpad: expect.objectContaining({
          backend: "codex",
          executionMode: "full-access",
          workMode: "worktree",
          model: "gpt-5.5-codex-max",
          tokenMiserEnabled: false,
          directoryKey: "dir:/Users/op/pwragent",
          directoryLabel: "PwrAgent",
          prompt: "",
        }),
        input: [
          { type: "text", text: "Fix the recorder crash" },
          {
            type: "localImage",
            name: "source.png",
            path: "/pwragent/staged/source.png",
          },
        ],
      },
      {
        messageOrigin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "thread-1",
          },
        },
      },
    );
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

  it("rejects a Token Miser override for ACP-backed projects", async () => {
    const variants: Array<{
      name: string;
      snapshot: NavigationSnapshot;
    }> = [
      {
        name: "saved launchpad",
        snapshot: buildSnapshot({
          directories: [{
            key: "dir:/repo",
            kind: "directory",
            label: "ACP project",
            path: "/repo",
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad: {
              backend: "acp:grok",
              executionMode: "default",
              workMode: "local",
              directoryKey: "dir:/repo",
              directoryKind: "directory",
              directoryLabel: "ACP project",
              prompt: "",
              createdAt: 1,
              updatedAt: 2,
            },
          }] as NavigationSnapshot["directories"],
        }),
      },
      {
        name: "instance default",
        snapshot: buildSnapshot({
          directories: [{
            key: "dir:/repo",
            kind: "directory",
            label: "Default ACP project",
            path: "/repo",
            threadKeys: [],
            needsAttentionCount: 0,
          }] as NavigationSnapshot["directories"],
          launchpadDefaults: {
            backend: "acp:grok",
            executionMode: "default",
            workMode: "local",
          },
        }),
      },
    ];

    for (const variant of variants) {
      const materializeDirectoryLaunchpad = vi.fn();
      const handler = createFederationAgentToolsHandler({
        collectHostInfo: async () => localHostInfo,
        runtime: buildRuntime({
          health: async () => buildHealth(),
          localBackend: (() => ({
            readPopulation: async () => variant.snapshot,
            materializeDirectoryLaunchpad,
          })) as never,
        }),
      });

      const response = await handler({
        operation: "create_instance_thread",
        context,
        args: {
          instanceId: "pwr_local",
          projectKey: "dir:/repo",
          tokenMiserEnabled: true,
        },
      });

      expect(response, variant.name).toMatchObject({
        ok: false,
        error: {
          code: "invalid_arguments",
          message: expect.stringContaining("supported only for Codex projects"),
        },
      });
      expect(materializeDirectoryLaunchpad, variant.name).not.toHaveBeenCalled();
    }
  });

  it("does not carry a stale inherited Token Miser setting into an ACP draft", async () => {
    let materializedRequest: MaterializeDirectoryLaunchpadRequest | undefined;
    const materializeDirectoryLaunchpad = vi.fn(
      async (request: MaterializeDirectoryLaunchpadRequest) => {
        materializedRequest = request;
        return {
          backend: "acp:grok" as const,
          threadId: "acp-thread",
          executionMode: "default" as const,
          workMode: "local" as const,
        };
      },
    );
    const handler = createFederationAgentToolsHandler({
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({
          readPopulation: async () => buildSnapshot({
            directories: [{
              key: "dir:/repo",
              kind: "directory",
              label: "ACP project",
              path: "/repo",
              threadKeys: [],
              needsAttentionCount: 0,
              launchpad: {
                backend: "acp:grok",
                executionMode: "default",
                workMode: "local",
                tokenMiserEnabled: true,
                directoryKey: "dir:/repo",
                directoryKind: "directory",
                directoryLabel: "ACP project",
                prompt: "",
                createdAt: 1,
                updatedAt: 2,
              },
            }] as NavigationSnapshot["directories"],
          }),
          materializeDirectoryLaunchpad,
        })) as never,
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: {
        instanceId: "pwr_local",
        projectKey: "dir:/repo",
      },
    });

    expect(response).toMatchObject({ ok: true });
    expect(materializedRequest).toBeDefined();
    expect(materializedRequest?.launchpad).not.toHaveProperty(
      "tokenMiserEnabled",
    );
  });

  it("remembers a remotely created thread and returns an addressed link", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-thread-9",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "remote-turn-9",
    }));
    const readPopulation = vi.fn(async () =>
      buildSnapshot({
        directories: [{
          key: "dir:/repo",
          kind: "directory",
          label: "PwrAgent",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }] as NavigationSnapshot["directories"],
      }),
    );
    const rememberRemoteThreadTarget = vi.fn(async (target) => ({
      ...target,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    }));
    const handler = createFederationAgentToolsHandler({
      collectHostInfo: async () => localHostInfo,
      targetStore: {
        rememberRemoteThreadTarget,
        listRemoteThreadTargets: vi.fn(async () => []),
      },
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [{
              id: "pwr_studio",
              label: "Studio Mac",
              role: "client",
              status: "connected",
              capabilities: ["thread_navigation", "environment_actions"],
            }],
          }),
        remoteBackend: (() => ({
          readPopulation,
          materializeDirectoryLaunchpad,
        })) as never,
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: {
        instanceId: "pwr_studio",
        projectKey: "dir:/repo",
        input: "Deploy the recoverable runner",
        workMode: "local",
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: "Deploy the recoverable runner" }],
      }),
      {
        messageOrigin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "thread-1",
          },
        },
      },
    );
    const data = (response as { ok: true; data: CreateInstanceThreadResult })
      .data;
    expect(data.threadUrl).toContain("instanceId=pwr_studio");
    expect(data.threadLink).toContain("instanceId=pwr_studio");
    expect(rememberRemoteThreadTarget).toHaveBeenCalledWith({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
      backend: "codex",
      threadId: "remote-thread-9",
    });
    expect(data.groupingMode).toBe("none");
  });

  it("mounts a delegated sibling on its remote group-root owner", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "remote-child",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "remote-turn",
    }));
    const addRemoteThreadPin = vi.fn(async () => undefined);
    const mountRemoteChild = vi.fn(async () => ({ mounted: true as const }));
    const onRemoteChildMounted = vi.fn(async () => undefined);
    const rememberRemoteThreadTarget = vi.fn(async (target) => ({
      ...target,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    }));
    const handler = createFederationAgentToolsHandler({
      collectHostInfo: async () => localHostInfo,
      onRemoteChildMounted,
      targetStore: {
        addRemoteThreadPin,
        rememberRemoteThreadTarget,
        listRemoteThreadTargets: vi.fn(async () => []),
      },
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [
              {
                id: "pwr_studio",
                label: "Studio Mac",
                role: "client",
                status: "connected",
                capabilities: ["thread_navigation", "environment_actions"],
              },
              {
                id: "pwr_root",
                label: "Root Mac",
                role: "client",
                status: "connected",
                capabilities: ["thread_navigation"],
              },
            ],
          }),
        localBackend: (() => ({
          readPopulation: async () =>
            buildSnapshot({
              threads: [{
                source: "codex",
                id: "thread-1",
                title: "Existing child",
                titleSource: "derived",
                linkedDirectories: [],
                inbox: { inInbox: false },
                parentThreadId: "group-root",
                parentThreadBackend: "acp:grok",
                parentThreadInstanceId: "pwr_root",
              }] as NavigationSnapshot["threads"],
            }),
        })) as never,
        remoteBackend: ((target: { instanceId: string }) =>
          target.instanceId === "pwr_root"
            ? { mountRemoteChild }
            : {
                readPopulation: async () =>
                  buildSnapshot({
                    directories: [{
                      key: "dir:/repo",
                      kind: "directory",
                      label: "PwrAgent",
                      path: "/repo",
                      threadKeys: [],
                      needsAttentionCount: 0,
                    }] as NavigationSnapshot["directories"],
                  }),
                materializeDirectoryLaunchpad,
              }) as never,
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: {
        instanceId: "pwr_studio",
        projectKey: "dir:/repo",
        groupingMode: "subthread",
        workMode: "local",
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: "group-root",
        parentThreadBackend: "acp:grok",
        parentThreadInstanceId: "pwr_root",
      }),
      expect.objectContaining({
        messageOrigin: expect.objectContaining({ kind: "agent" }),
      }),
    );
    expect(mountRemoteChild).toHaveBeenCalledWith(expect.objectContaining({
      ref: {
        backend: "codex",
        target: { scope: "remote", instanceId: "pwr_studio" },
        threadId: "remote-child",
      },
      instanceLabel: "Studio Mac",
      summary: expect.objectContaining({
        parentThreadId: "group-root",
        parentThreadBackend: "acp:grok",
        parentThreadInstanceId: "pwr_root",
      }),
    }));
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
    expect(onRemoteChildMounted).not.toHaveBeenCalled();
    expect(rememberRemoteThreadTarget).toHaveBeenCalledWith({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
      backend: "codex",
      threadId: "remote-child",
    });
    expect(response).toMatchObject({
      ok: true,
      data: {
        groupingMode: "subthread",
        groupedUnderThreadId: "group-root",
      },
    });
  });

  it("mounts a locally created sibling on its remote group-root owner", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "local-sibling",
      executionMode: "default" as const,
      workMode: "local" as const,
    }));
    const mountRemoteChild = vi.fn(async () => ({ mounted: true as const }));
    const localSnapshot = buildSnapshot({
      directories: [{
        key: "dir:/repo",
        kind: "directory",
        label: "PwrAgent",
        path: "/repo",
        threadKeys: [],
        needsAttentionCount: 0,
      }] as NavigationSnapshot["directories"],
      threads: [{
        source: "codex",
        id: "thread-1",
        title: "Existing child",
        titleSource: "derived",
        linkedDirectories: [],
        inbox: { inInbox: false },
        parentThreadId: "group-root",
        parentThreadBackend: "codex",
        parentThreadInstanceId: "pwr_root",
      }] as NavigationSnapshot["threads"],
    });
    const handler = createFederationAgentToolsHandler({
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () =>
          buildHealth({
            peers: [{
              id: "pwr_root",
              label: "Root Mac",
              role: "client",
              status: "connected",
              capabilities: ["thread_navigation"],
            }],
          }),
        localBackend: (() => ({
          readPopulation: async () => localSnapshot,
          materializeDirectoryLaunchpad,
        })) as never,
        remoteBackend: (() => ({ mountRemoteChild })) as never,
      }),
    });

    const response = await handler({
      operation: "create_instance_thread",
      context,
      args: {
        instanceId: "pwr_local",
        projectKey: "dir:/repo",
        groupingMode: "subthread",
        workMode: "local",
      },
    });

    expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: "group-root",
        parentThreadBackend: "codex",
        parentThreadInstanceId: "pwr_root",
      }),
      expect.objectContaining({
        messageOrigin: expect.objectContaining({ kind: "agent" }),
      }),
    );
    expect(mountRemoteChild).toHaveBeenCalledWith(expect.objectContaining({
      ref: {
        backend: "codex",
        target: { scope: "remote", instanceId: "pwr_local" },
        threadId: "local-sibling",
      },
      instanceLabel: "Local Mac",
      summary: expect.objectContaining({
        parentThreadId: "group-root",
        parentThreadInstanceId: "pwr_root",
      }),
    }));
    expect(response).toMatchObject({
      ok: true,
      data: {
        isLocal: true,
        groupedUnderThreadId: "group-root",
      },
    });
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
    const rememberRemoteThreadTarget = vi.fn(async (target) => ({
      ...target,
      firstSeenAt: 1_000,
      lastSeenAt: 1_000,
    }));
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      targetStore: {
        rememberRemoteThreadTarget,
        listRemoteThreadTargets: vi.fn(async () => []),
      },
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({
          listThreads: async () => ({
            backend: "all",
            fetchedAt: 10,
            threads: Array.from({ length: 100 }, (_, index) => ({ ...localThread, id: `local-${index}` })),
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
          listThreads: vi.fn(),
          searchFederatedThreads: async () => ({
            threads: [remoteThread],
            totalCount: 1,
            truncated: false,
          }),
        })) as never,
      }),
    });

    const response = await handler({
      operation: "search_federation_threads",
      context,
      args: { query: "recorder crash", limit: 1 },
    });

    const data = (response as { ok: true; data: SearchFederationThreadsResult })
      .data;
    expect(data.results).toHaveLength(1);
    const remote = data.results.find((entry) => !entry.isLocal);
    expect(remote).toMatchObject({
      instanceId: "pwr_studio",
      instanceLabel: "Studio Mac",
      threadId: "thread-remote",
    });
    expect(remote?.threadLink).toContain(
      "instanceId=pwr_studio",
    );
    expect(rememberRemoteThreadTarget).not.toHaveBeenCalled();
    expect(data.searchedInstances).toEqual([
      { instanceId: "pwr_local", instanceLabel: "Local Mac", resultCount: 100, truncated: true },
      { instanceId: "pwr_studio", instanceLabel: "Studio Mac", resultCount: 1 },
    ]);
  });

  it("excludes local results for scope remote and peers for scope local", async () => {
    const localListThreads = vi.fn(async () => ({
      backend: "all",
      fetchedAt: 10,
      threads: [
        {
          id: "thread-local",
          title: "Recorder crash on stop",
          source: "codex" as const,
          linkedDirectories: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    }));
    const remoteListThreads = vi.fn(async () => ({
      backend: "all",
      fetchedAt: 10,
      threads: [
        {
          id: "thread-remote",
          title: "Recorder crash investigation",
          source: "codex" as const,
          linkedDirectories: [],
          createdAt: 1,
          updatedAt: 3,
        },
      ],
    }));
    const remoteSearchThreads = vi.fn(async () => ({
      threads: [
        {
          id: "thread-remote",
          title: "Recorder crash investigation",
          source: "codex" as const,
          linkedDirectories: [],
          createdAt: 1,
          updatedAt: 3,
        },
      ],
      totalCount: 1,
      truncated: false,
    }));
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
      runtime: buildRuntime({
        health: async () => buildHealth(),
        localBackend: (() => ({ listThreads: localListThreads })) as never,
        connectedPeerTargets: () => [
          {
            target: { scope: "remote", instanceId: "pwr_studio" },
            label: "Studio Mac",
            capabilities: ["federated_search"],
          },
        ],
        remoteBackend: (() => ({
          listThreads: remoteListThreads,
          searchFederatedThreads: remoteSearchThreads,
        })) as never,
      }),
    });

    const remoteOnly = await handler({
      operation: "search_federation_threads",
      context,
      args: { query: "recorder crash", scope: "remote" },
    });
    const remoteData = (
      remoteOnly as { ok: true; data: SearchFederationThreadsResult }
    ).data;
    expect(localListThreads).not.toHaveBeenCalled();
    expect(remoteData.results.map((entry) => entry.threadId)).toEqual([
      "thread-remote",
    ]);
    expect(remoteData.searchedInstances).toEqual([
      { instanceId: "pwr_studio", instanceLabel: "Studio Mac", resultCount: 1 },
    ]);

    const localOnly = await handler({
      operation: "search_federation_threads",
      context,
      args: { query: "recorder crash", scope: "local" },
    });
    const localData = (
      localOnly as { ok: true; data: SearchFederationThreadsResult }
    ).data;
    expect(remoteSearchThreads).toHaveBeenCalledTimes(1);
    expect(remoteListThreads).not.toHaveBeenCalled();
    expect(localData.results.map((entry) => entry.threadId)).toEqual([
      "thread-local",
    ]);
    expect(localData.searchedInstances).toEqual([
      { instanceId: "pwr_local", instanceLabel: "Local Mac", resultCount: 1 },
    ]);
  });

  it("scopes search_federation_threads to one peer and skips local", async () => {
    const localListThreads = vi.fn();
    const handler = createFederationAgentToolsHandler({
      // Never let unit tests mint a machine-id in the real PwrAgent root.
      collectHostInfo: async () => localHostInfo,
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
          listThreads: vi.fn(),
          searchFederatedThreads: async () => ({
            threads: [],
            totalCount: 0,
            truncated: false,
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

it("returns one bounded project page and requires an explicit continuation", async () => {
  const readPopulation = vi.fn(async () => buildSnapshot({ directories: Array.from({ length: 1000 }, (_, i) => ({
    key: `directory:${i}`, kind: "directory", label: `Project ${i}`, threadKeys: [], needsAttentionCount: 0,
  })) }));
  const handler = createFederationAgentToolsHandler({ collectHostInfo: async () => localHostInfo,
    runtime: buildRuntime({ health: async () => buildHealth(), localBackend: (() => ({ readPopulation })) as never }) });
  const first = await handler({ operation: "list_instance_projects", context, args: { instanceId: "pwr_local", limit: 10 } });
  expect(first.ok).toBe(true);
  const page = (first as { ok: true; data: ListInstanceProjectsResult }).data;
  expect(page.projects).toHaveLength(10);
  expect(page.complete).toBe(false);
  expect(page.nextCursor).toBe("10");
  expect(readPopulation).toHaveBeenCalledTimes(1);
  const next = await handler({ operation: "list_instance_projects", context,
    args: { instanceId: "pwr_local", limit: 10, cursor: page.nextCursor } });
  expect((next as { ok: true; data: ListInstanceProjectsResult }).data.projects[0]?.key).toBe("directory:10");
  expect(readPopulation).toHaveBeenCalledTimes(2);
});
