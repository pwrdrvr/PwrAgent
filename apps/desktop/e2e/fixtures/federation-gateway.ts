import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  EnsureDirectoryLaunchpadRequest,
  EnsureDirectoryLaunchpadResponse,
  LinkedDirectorySummary,
  ListBackendsResponse,
  MaterializeDirectoryLaunchpadRequest,
  MaterializeDirectoryLaunchpadResponse,
  NavigationSnapshot,
  SetThreadPinRequest,
  SetThreadPinResponse,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  FEDERATION_INVITE_VERSION,
  FEDERATION_PROTOCOL_VERSION,
} from "@pwragent/shared";
import { StateDb } from "../../src/main/state/state-db";
import {
  createFederationEnrollmentInvite,
  encodeFederationInvite,
} from "../../src/main/federation/federation-enrollment";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  additionalFederationBackendCapabilities,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../../src/main/federation/federation-backend-bridge";
import { generateFederationIdentityKeyPair } from "../../src/main/federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../../src/main/federation/federation-noise";
import {
  FEDERATION_PTY_METHOD_CAPABILITIES,
  FederationPtyService,
  registerFederationPtyHandlers,
  type FederationPtyProcess,
} from "../../src/main/federation/federation-pty-service";
import { FederationRouter } from "../../src/main/federation/federation-router";
import { FederationStore } from "../../src/main/federation/federation-store";
import { FederationGatewayWebSocketServer } from "../../src/main/federation/federation-transport";

export type GatewayThreadSeed = {
  id: string;
  title: string;
  updatedAt: number;
  pinnedRank?: string;
  source?: AppServerBackendKind;
  executionMode?: AppServerThreadSummary["executionMode"];
  linkedDirectories?: LinkedDirectorySummary[];
};

export type GatewayDirectorySeed = {
  key: string;
  label: string;
  path: string;
  threadIds?: string[];
};

export type InProcessFederationGateway = {
  /** `pwragent-federation:<base64url>` invite for the Electron client. */
  invite: string;
  instanceId: string;
  instanceLabel: string;
  url: string;
  /** Requests the canned backend has served, oldest first. */
  calls: { method: string; params: unknown }[];
  /** Current pin rank per thread id (mutated by backend.setThreadPin). */
  pinnedRankByThreadId: Map<string, string | undefined>;
  /** Resolves when a client connection has completed enrollment/auth. */
  waitForConnection: (timeoutMs?: number) => Promise<void>;
  /** Resolves when a connection completes AFTER this call (reconnects). */
  waitForNextConnection: (timeoutMs?: number) => Promise<void>;
  /** Stop listening and drop live connections (simulates the peer dying). */
  stop: () => Promise<void>;
  /** Come back up on the SAME port + identity so clients can reconnect. */
  restart: () => Promise<void>;
  close: () => Promise<void>;
};

/**
 * A real federation gateway running inside the Playwright test process:
 * real sqlite-backed FederationStore, real Noise_IK WebSocket transport,
 * real capability-checked router — only the backend behind it is canned.
 * The launched Electron app enrolls into it as a genuine client, so
 * everything from invite redemption to remote-thread rendering runs the
 * production code path on both sides of the wire.
 */
export async function startInProcessFederationGateway(params: {
  threads: GatewayThreadSeed[];
  directories?: GatewayDirectorySeed[];
  instanceLabel?: string;
  /**
   * Serve remote PTY sessions with a REAL shell spawned via node-pty inside
   * the test process, rooted at `cwd`. This is what lets the E2E prove the
   * command ran on the OWNER: the marker file lands in this directory, not
   * anywhere the Electron viewer can write.
   */
  remotePty?: { cwd: string };
}): Promise<InProcessFederationGateway> {
  const stateRoot = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-e2e-federation-gateway-"),
  );
  const stateDb = StateDb.open(path.join(stateRoot, "state.db"));
  const store = new FederationStore(stateDb);
  const identity = generateFederationIdentityKeyPair();
  const noiseStatic = generateNoiseStaticKeyPair();
  const gatewayInstanceId = `e2e_gateway_${randomBytes(4).toString("hex")}`;
  const instanceLabel = params.instanceLabel ?? "E2E Gateway";
  const directories = params.directories ?? [];
  const threads = [...params.threads];

  const calls: { method: string; params: unknown }[] = [];
  const pinnedRankByThreadId = new Map<string, string | undefined>(
    threads.map((thread) => [thread.id, thread.pinnedRank]),
  );

  const threadSummaries = (): AppServerThreadSummary[] =>
    threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      titleSource: "explicit" as const,
      source: thread.source ?? "codex",
      executionMode: thread.executionMode,
      linkedDirectories:
        thread.linkedDirectories ??
        (directories[0]
          ? [{
              id: directories[0].path,
              label: directories[0].label,
              path: directories[0].path,
              kind: "local" as const,
            }]
          : []),
      updatedAt: thread.updatedAt,
      createdAt: thread.updatedAt,
      ...(pinnedRankByThreadId.get(thread.id) !== undefined
        ? { pinnedRank: pinnedRankByThreadId.get(thread.id) }
        : {}),
    }));

  const navigationSnapshot = (): NavigationSnapshot => ({
    backend: "all",
    fetchedAt: Date.now(),
    unchanged: false,
    threads: threadSummaries().map((thread) => ({
      ...thread,
      inbox: { inInbox: true },
    })),
    inboxThreadKeys: threads.map(
      (thread) => buildThreadIdentityKey(thread.source ?? "codex", thread.id),
    ),
    directories: directories.map((directory) => ({
      key: directory.key,
      kind: "directory" as const,
      label: directory.label,
      path: directory.path,
      threadKeys: threads
        .filter(
          (thread) =>
            !directory.threadIds || directory.threadIds.includes(thread.id),
        )
        .map((thread) =>
          buildThreadIdentityKey(thread.source ?? "codex", thread.id),
        ),
      needsAttentionCount: 0,
    })),
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
  });

  const backend = {
    async getNavigationSnapshot(): Promise<NavigationSnapshot> {
      calls.push({ method: "getNavigationSnapshot", params: {} });
      return navigationSnapshot();
    },
    async listThreads() {
      calls.push({ method: "listThreads", params: {} });
      return {
        backend: "all" as const,
        fetchedAt: Date.now(),
        threads: threadSummaries(),
      };
    },
    async readThread(
      request: AppServerReadThreadRequest,
    ): Promise<AppServerReadThreadResponse> {
      calls.push({ method: "readThread", params: request });
      const thread = threads.find((entry) => entry.id === request.threadId);
      const text = `Remote transcript for ${thread?.title ?? request.threadId}.`;
      return {
        backend: thread?.source ?? request.backend ?? "codex",
        fetchedAt: Date.now(),
        threadId: request.threadId,
        replay: {
          entries: [
            {
              type: "message",
              id: `${request.threadId}-message-1`,
              role: "assistant",
              text,
            },
          ],
          messages: [
            {
              id: `${request.threadId}-message-1`,
              role: "assistant",
              text,
            },
          ],
          lastAssistantMessage: text,
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      } as AppServerReadThreadResponse;
    },
    async listSkills() {
      calls.push({ method: "listSkills", params: {} });
      return { backend: "codex" as const, fetchedAt: Date.now(), data: [] };
    },
    async listBackends(): Promise<ListBackendsResponse> {
      calls.push({ method: "listBackends", params: {} });
      return {
        fetchedAt: Date.now(),
        backends: [
          {
            kind: "codex",
            label: "OpenAI",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start"],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default",
                available: true,
                isDefault: true,
              },
            ],
          },
          {
            kind: "acp:kimi",
            label: "Kimi Code",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start"],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default",
                available: true,
                isDefault: true,
              },
            ],
          },
        ],
      };
    },
    async markThreadSeen(request: { threadId: string }) {
      calls.push({ method: "markThreadSeen", params: request });
      return { backend: "codex" as const, threadId: request.threadId };
    },
    async setThreadPin(
      request: SetThreadPinRequest,
    ): Promise<SetThreadPinResponse> {
      calls.push({ method: "setThreadPin", params: request });
      pinnedRankByThreadId.set(request.threadId, request.pinnedRank ?? undefined);
      return {
        backend: request.backend ?? "codex",
        threadId: request.threadId,
        ...(request.pinnedRank ? { pinnedRank: request.pinnedRank } : {}),
      };
    },
    async readMessagingPlatformStatuses() {
      calls.push({ method: "readMessagingPlatformStatuses", params: {} });
      return [];
    },
    async listScheduledThreadActions() {
      calls.push({ method: "listScheduledThreadActions", params: {} });
      return { actions: [] };
    },
    async ensureDirectoryLaunchpad(
      request: EnsureDirectoryLaunchpadRequest,
    ): Promise<EnsureDirectoryLaunchpadResponse> {
      calls.push({ method: "ensureDirectoryLaunchpad", params: request });
      const directory = directories.find(
        (entry) =>
          entry.key === request.directoryKey
          || entry.path === request.directoryPath,
      );
      const now = Date.now();
      return {
        launchpad: {
          directoryKey: request.directoryKey,
          directoryKind: request.directoryKind,
          directoryLabel: directory?.label ?? request.directoryLabel,
          directoryPath: directory?.path ?? request.directoryPath,
          backend: request.preferredBackend ?? "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: now,
          updatedAt: now,
        },
        defaults: {
          backend: "codex",
          executionMode: "default",
        },
        gitStatus: {
          currentBranch: "main",
          branches: ["main"],
          baseBranches: ["main", "origin/main"],
        },
      };
    },
    async materializeDirectoryLaunchpad(
      request: MaterializeDirectoryLaunchpadRequest,
    ): Promise<MaterializeDirectoryLaunchpadResponse> {
      calls.push({ method: "materializeDirectoryLaunchpad", params: request });
      const threadId = `remote-created-${threads.length + 1}`;
      const prompt =
        request.input?.find((item) => item.type === "text")?.text.trim()
        ?? request.launchpad?.prompt.trim()
        ?? "";
      threads.unshift({
        id: threadId,
        title: prompt || "Remote created thread",
        updatedAt: Date.now(),
        source: request.launchpad?.backend ?? "codex",
      });
      return {
        backend: request.launchpad?.backend ?? "codex",
        threadId,
        executionMode: request.launchpad?.executionMode ?? "default",
        workMode: request.launchpad?.workMode ?? "local",
        turnId: `turn-${threadId}`,
      };
    },
  } as unknown as FederationBackendOperations;

  const router = new FederationRouter({
    localInstanceId: gatewayInstanceId,
    methodCapabilities: {
      ...FEDERATION_BACKEND_METHOD_CAPABILITIES,
      ...FEDERATION_PTY_METHOD_CAPABILITIES,
    },
    additionalRequiredCapabilities: additionalFederationBackendCapabilities,
  });
  registerFederationBackendHandlers({ router, backend });

  let ptyService: FederationPtyService | undefined;
  if (params.remotePty) {
    const ptyCwd = params.remotePty.cwd;
    ptyService = new FederationPtyService({
      spawnPty: async (spawnParams) => {
        // node-pty ships prebuilds for the plain-Node ABI too, so the OWNER
        // side of the wire runs a genuine PTY inside the Playwright process.
        const nodePty = await import("node-pty");
        const shell = resolveHarnessShell();
        const pty = nodePty.spawn(shell.file, shell.args, {
          name: "xterm-256color",
          cols: spawnParams.cols,
          rows: spawnParams.rows,
          cwd: spawnParams.cwd ?? ptyCwd,
          env: { ...process.env, TERM: "xterm-256color" },
        });
        return {
          pty: pty as unknown as FederationPtyProcess,
          cwd: spawnParams.cwd ?? ptyCwd,
          shell: { file: shell.file, args: shell.args },
        };
      },
      resolveThreadCwd: async () => ptyCwd,
      sendNotification: (peerId, method, notificationParams) =>
        router.sendToPeer(peerId, {
          id: `federation-pty:${randomBytes(8).toString("hex")}`,
          kind: "notification",
          method,
          params: notificationParams,
          protocolVersion: FEDERATION_PROTOCOL_VERSION,
          sourceInstanceId: gatewayInstanceId,
          targetInstanceId: peerId,
          createdAt: Date.now(),
        }),
      graceMs: 2_000,
    });
    registerFederationPtyHandlers({ router, service: ptyService });
  }

  let connectionCount = 0;
  const connectionWaiters: (() => void)[] = [];
  const buildServer = (port: number) =>
    new FederationGatewayWebSocketServer({
      gatewayInstanceId,
      gatewayPrivateKeyPem: identity.privateKeyPem,
      gatewayPublicKeyPem: identity.publicKeyPem,
      host: "127.0.0.1",
      port,
      store,
      noiseStatic,
      onConnection: (connection) => {
        router.registerConnection({
          peerId: connection.peerId,
          capabilities: connection.capabilities,
          sendEnvelope: connection.sendEnvelope,
        });
        ptyService?.notifyPeerConnected(connection.peerId);
        connectionCount += 1;
        for (const resolve of connectionWaiters.splice(0)) {
          resolve();
        }
      },
      onDisconnect: (connection) => {
        router.unregisterConnection(connection.peerId);
        ptyService?.notifyPeerDisconnected(connection.peerId);
      },
      onEnvelope: (envelope, connection) => {
        void router.routeEnvelope({
          envelope,
          sourcePeerId: connection.peerId,
        });
      },
    });
  let server = buildServer(0);
  const { url, port } = await server.start();

  const waitForConnectionCount = async (
    minimumCount: number,
    timeoutMs: number,
  ): Promise<void> => {
    if (connectionCount >= minimumCount) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error("Timed out waiting for a federation client connection"),
        );
      }, timeoutMs);
      const waiter = () => {
        if (connectionCount >= minimumCount) {
          clearTimeout(timer);
          resolve();
          return;
        }
        connectionWaiters.push(waiter);
      };
      connectionWaiters.push(waiter);
    });
  };

  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  createFederationEnrollmentInvite({
    store,
    token,
    gatewayInstanceId,
    generatedAt: now,
    expiresAt: now + 60 * 60 * 1000,
    label: instanceLabel,
    role: "client",
    endpoint: url,
  });
  const invite = encodeFederationInvite({
    version: FEDERATION_INVITE_VERSION,
    token,
    gatewayInstanceId,
    gatewayPublicKeyPem: identity.publicKeyPem,
    gatewayNoisePublicKey: noiseStatic.publicKeyRaw.toString("base64"),
    gatewayUrl: url,
    expiresAt: now + 60 * 60 * 1000,
  });

  return {
    invite,
    instanceId: gatewayInstanceId,
    instanceLabel,
    url,
    calls,
    pinnedRankByThreadId,
    waitForConnection: async (timeoutMs = 15_000) => {
      await waitForConnectionCount(1, timeoutMs);
    },
    waitForNextConnection: async (timeoutMs = 60_000) => {
      await waitForConnectionCount(connectionCount + 1, timeoutMs);
    },
    stop: async () => {
      await server.stop();
    },
    restart: async () => {
      // Same port, identity, and sqlite store: the returning "machine"
      // is the one the client pinned, so reconnect auth must succeed.
      server = buildServer(port);
      await server.start();
    },
    close: async () => {
      ptyService?.disposeAll();
      await server.stop();
      stateDb.close();
      await rm(stateRoot, { force: true, recursive: true });
    },
  };
}

/**
 * Minimal per-platform shell pick for the harness-owned PTY. The production
 * owner resolves this through the settings service; the harness only needs a
 * real interactive shell for `echo`-level commands.
 */
function resolveHarnessShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: [] };
  }
  const configured = process.env.SHELL?.trim();
  return { file: configured || "/bin/sh", args: [] };
}
