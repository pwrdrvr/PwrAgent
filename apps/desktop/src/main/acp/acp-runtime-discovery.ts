import type {
  AcpBackendId,
  BackendAcpRuntimeCapabilities,
  BackendAcpRuntimeConfigOption,
  BackendAcpRuntimeModel,
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
    const session = await client.startSession({
      cwd: options.cwd,
      executionMode: "default",
      title: "ACP capability discovery",
    });
    runtimeCapabilities = await discoverModelReasoningCapabilities({
      client,
      readRuntimeCapabilities: () => runtimeCapabilities,
      sessionId: session.sessionId,
    });
    return { runtimeCapabilities, runtimeState };
  } finally {
    await client.dispose();
  }
}

async function discoverModelReasoningCapabilities(params: {
  client: AcpAgentClient;
  readRuntimeCapabilities: () => BackendAcpRuntimeCapabilities | undefined;
  sessionId: string;
}): Promise<BackendAcpRuntimeCapabilities | undefined> {
  const initial = params.readRuntimeCapabilities();
  const modelOption = findConfigOption(initial, "model");
  const thoughtLevelOption = findConfigOption(initial, "thought_level");
  if (!modelOption || !thoughtLevelOption || modelOption.values.length === 0) {
    return initial;
  }

  const originalModel = modelOption.currentValue;
  let selectedModel = originalModel;
  const models: BackendAcpRuntimeModel[] = [];
  try {
    for (const model of modelOption.values) {
      if (model.value !== selectedModel) {
        try {
          await params.client.setRuntimeOption({
            sessionId: params.sessionId,
            source: "configOption",
            optionId: modelOption.id,
            value: model.value,
          });
          selectedModel = model.value;
        } catch {
          models.push({
            id: model.value,
            label: model.label,
          });
          continue;
        }
      }

      const currentCapabilities = params.readRuntimeCapabilities();
      const currentThoughtLevel =
        findConfigOption(currentCapabilities, "thought_level");
      const reasoningEfforts =
        currentThoughtLevel?.values.map((value) => value.value) ?? [];
      const supportsReasoning = reasoningEfforts.length > 1;
      models.push({
        id: model.value,
        label: model.label,
        current: model.value === originalModel,
        ...(supportsReasoning
          ? {
              supportsReasoning: true,
              reasoningEfforts,
              ...(currentThoughtLevel?.currentValue
                ? {
                    defaultReasoningEffort:
                      currentThoughtLevel.currentValue,
                  }
                : {}),
            }
          : { supportsReasoning: false }),
      });
    }
  } finally {
    if (originalModel && selectedModel !== originalModel) {
      await params.client.setRuntimeOption({
        sessionId: params.sessionId,
        source: "configOption",
        optionId: modelOption.id,
        value: originalModel,
      }).catch(() => undefined);
    }
  }

  const restored = params.readRuntimeCapabilities() ?? initial;
  return restored
    ? {
        ...restored,
        models: {
          availableModels: models,
          ...(originalModel ? { currentModelId: originalModel } : {}),
        },
      }
    : restored;
}

function findConfigOption(
  capabilities: BackendAcpRuntimeCapabilities | undefined,
  category: string,
): BackendAcpRuntimeConfigOption | undefined {
  return capabilities?.configOptions?.find(
    (option) => option.category === category,
  );
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
