import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppServerReadThreadRequest,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  NavigationSnapshot,
  SetThreadPinRequest,
  SetThreadPinResponse,
} from "@pwragent/shared";
import { FEDERATION_INVITE_VERSION } from "@pwragent/shared";
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
import { FederationRouter } from "../../src/main/federation/federation-router";
import { FederationStore } from "../../src/main/federation/federation-store";
import { FederationGatewayWebSocketServer } from "../../src/main/federation/federation-transport";

export type GatewayThreadSeed = {
  id: string;
  title: string;
  updatedAt: number;
  pinnedRank?: string;
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
  instanceLabel?: string;
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

  const calls: { method: string; params: unknown }[] = [];
  const pinnedRankByThreadId = new Map<string, string | undefined>(
    params.threads.map((thread) => [thread.id, thread.pinnedRank]),
  );

  const threadSummaries = (): AppServerThreadSummary[] =>
    params.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
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
    inboxThreadKeys: params.threads.map((thread) => `codex:${thread.id}`),
    directories: [],
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
      const thread = params.threads.find((entry) => entry.id === request.threadId);
      const text = `Remote transcript for ${thread?.title ?? request.threadId}.`;
      return {
        backend: "codex",
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
    async listBackends() {
      calls.push({ method: "listBackends", params: {} });
      return { backends: [] };
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
  } as unknown as FederationBackendOperations;

  const router = new FederationRouter({
    localInstanceId: gatewayInstanceId,
    methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    additionalRequiredCapabilities: additionalFederationBackendCapabilities,
  });
  registerFederationBackendHandlers({ router, backend });

  let connectionCount = 0;
  const connectionWaiters: (() => void)[] = [];
  const server = new FederationGatewayWebSocketServer({
    gatewayInstanceId,
    gatewayPrivateKeyPem: identity.privateKeyPem,
    gatewayPublicKeyPem: identity.publicKeyPem,
    host: "127.0.0.1",
    port: 0,
    store,
    noiseStatic,
    onConnection: (connection) => {
      router.registerConnection({
        peerId: connection.peerId,
        capabilities: connection.capabilities,
        sendEnvelope: connection.sendEnvelope,
      });
      connectionCount += 1;
      for (const resolve of connectionWaiters.splice(0)) {
        resolve();
      }
    },
    onDisconnect: (connection) => {
      router.unregisterConnection(connection.peerId);
    },
    onEnvelope: (envelope, connection) => {
      void router.routeEnvelope({
        envelope,
        sourcePeerId: connection.peerId,
      });
    },
  });
  const { url } = await server.start();

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
      if (connectionCount > 0) return;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("Timed out waiting for a federation client connection"));
        }, timeoutMs);
        connectionWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    close: async () => {
      await server.stop();
      stateDb.close();
      await rm(stateRoot, { force: true, recursive: true });
    },
  };
}
