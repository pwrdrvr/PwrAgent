import type {
  AcpBackendId,
  BackendAcpRuntimeCapabilities,
  BackendAcpSessionRuntimeState,
} from "@pwragent/shared";
import { AcpAgentClient, type AcpJsonRpcTransport } from "./acp-client.js";
import { AcpStdioJsonRpcTransport } from "./acp-stdio-transport.js";
import type {
  AcpSessionMetadata,
  AcpSessionStore,
} from "./acp-session-store.js";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";

const ACP_DISCOVERY_REQUEST_TIMEOUT_MS = 20_000;

export type AcpRuntimeDiscoveryResult = {
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
  runtimeState?: BackendAcpSessionRuntimeState;
};

export async function discoverAcpRuntimeCapabilities(
  agent: AcpInstalledAgentRecord,
  options: {
    cwd: string;
    now?: () => number;
    transportFactory?: (agent: AcpInstalledAgentRecord) => AcpJsonRpcTransport;
  },
): Promise<AcpRuntimeDiscoveryResult> {
  if (!agent.launchDescriptor) {
    throw new Error(`ACP backend ${agent.backendId} has no launch descriptor`);
  }

  let runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined;
  let runtimeState: BackendAcpSessionRuntimeState | undefined;
  const store = new MemoryAcpSessionStore();
  const transport =
    options.transportFactory?.(agent) ??
    new AcpStdioJsonRpcTransport({
      launchDescriptor: agent.launchDescriptor,
      requestTimeoutMs: ACP_DISCOVERY_REQUEST_TIMEOUT_MS,
    });
  const client = new AcpAgentClient({
    backendId: agent.backendId,
    store,
    transport,
    now: options.now,
    onRuntimeCapabilities: (event) => {
      runtimeCapabilities = event.runtimeCapabilities;
      runtimeState = event.runtimeState;
    },
  });

  try {
    await client.initialize();
    await client.startSession({
      cwd: options.cwd,
      executionMode: "default",
      title: "ACP capability discovery",
    });
    return { runtimeCapabilities, runtimeState };
  } finally {
    await client.dispose();
  }
}

class MemoryAcpSessionStore implements Pick<
  AcpSessionStore,
  "getSession" | "listSessions" | "upsertSession"
> {
  private readonly sessions = new Map<string, AcpSessionMetadata>();

  upsertSession(metadata: AcpSessionMetadata): void {
    this.sessions.set(sessionKey(metadata.backendId, metadata.sessionId), metadata);
  }

  listSessions(
    backendId: AcpBackendId,
    params?: { archived?: boolean },
  ): AcpSessionMetadata[] {
    const archived = params?.archived === true;
    return [...this.sessions.values()].filter(
      (session) =>
        session.backendId === backendId &&
        Boolean(session.archivedAt) === archived,
    );
  }

  getSession(
    backendId: AcpBackendId,
    sessionId: string,
  ): AcpSessionMetadata | undefined {
    return this.sessions.get(sessionKey(backendId, sessionId));
  }
}

function sessionKey(backendId: AcpBackendId, sessionId: string): string {
  return `${backendId}:${sessionId}`;
}
