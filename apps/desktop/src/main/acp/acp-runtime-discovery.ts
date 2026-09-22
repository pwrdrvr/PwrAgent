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
    requestTimeoutMs?: number;
    transportFactory?: (agent: AcpInstalledAgentRecord) => AcpJsonRpcTransport;
    /**
     * Aborting disposes the client, which terminates the agent's process tree
     * and fails the pending request, so a hung agent stops on demand rather
     * than holding its request timeout.
     */
    signal?: AbortSignal;
    /** Names the step in progress, for a surface that shows a hung agent. */
    onStage?: (stage: string) => void;
  },
): Promise<AcpRuntimeDiscoveryResult> {
  if (!agent.launchDescriptor) {
    throw new Error(`ACP backend ${agent.backendId} has no launch descriptor`);
  }
  options.signal?.throwIfAborted();

  let runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined;
  let runtimeState: BackendAcpSessionRuntimeState | undefined;
  const store = new MemoryAcpSessionStore();
  const transport =
    options.transportFactory?.(agent) ??
    new AcpStdioJsonRpcTransport({
      launchDescriptor: agent.launchDescriptor,
      requestTimeoutMs:
        options.requestTimeoutMs ?? ACP_DISCOVERY_REQUEST_TIMEOUT_MS,
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

  const abort = (): void => {
    void client.dispose().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    options.onStage?.("Starting the CLI");
    await client.initialize();
    options.onStage?.("Opening a session");
    const session = await client.startSession({
      cwd: options.cwd,
      executionMode: "default",
      title: "ACP capability discovery",
    });
    runtimeCapabilities = await discoverModelReasoningCapabilities({
      client,
      onStage: options.onStage,
      readRuntimeCapabilities: () => runtimeCapabilities,
      sessionId: session.sessionId,
    });
    options.signal?.throwIfAborted();
    return { runtimeCapabilities, runtimeState };
  } catch (error) {
    // The disposed transport rejects with "closed"; report the cancellation
    // instead, so a caller does not record it as a discovery failure.
    options.signal?.throwIfAborted();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await client.dispose();
  }
}

type DiscoverySession = {
  client: AcpAgentClient;
  onStage?: (stage: string) => void;
  readRuntimeCapabilities: () => BackendAcpRuntimeCapabilities | undefined;
  sessionId: string;
};

async function discoverModelReasoningCapabilities(
  params: DiscoverySession,
): Promise<BackendAcpRuntimeCapabilities | undefined> {
  const initial = params.readRuntimeCapabilities();
  const modelOption = findConfigOption(initial, "model");
  const thoughtLevelOption = findConfigOption(initial, "thought_level");
  if (!modelOption || !thoughtLevelOption || modelOption.values.length === 0) {
    return initial;
  }

  const originalModel = modelOption.currentValue;
  const originalThoughtLevel = thoughtLevelOption.currentValue;
  let selectedModel = originalModel;
  const models: BackendAcpRuntimeModel[] = [];
  // Rebuilding the list from config values must keep what only the agent's
  // own model list carries, such as Grok's context window size.
  const contextWindowFor = (modelId: string) => {
    const contextWindow = initial?.models?.availableModels.find(
      (model) => model.id === modelId,
    )?.contextWindow;
    return contextWindow !== undefined ? { contextWindow } : {};
  };
  try {
    for (const [index, model] of modelOption.values.entries()) {
      params.onStage?.(
        `Reading model ${index + 1} of ${modelOption.values.length}`,
      );
      let thoughtLevels: ModelThoughtLevels;
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
            ...contextWindowFor(model.value),
          });
          continue;
        }
        thoughtLevels = await settleCarriedThoughtLevel(
          params,
          thoughtLevelOption.id,
        );
      } else {
        thoughtLevels = readThoughtLevels(params.readRuntimeCapabilities());
      }

      const reasoningEfforts = thoughtLevels.values;
      const supportsReasoning = reasoningEfforts.length > 1;
      models.push({
        id: model.value,
        label: model.label,
        current: model.value === originalModel,
        ...contextWindowFor(model.value),
        ...(supportsReasoning
          ? {
              supportsReasoning: true,
              reasoningEfforts,
              ...(thoughtLevels.currentValue
                ? { defaultReasoningEffort: thoughtLevels.currentValue }
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
    // The restored model can still carry a level from the last model the
    // walk visited, and the returned capabilities report its menu.
    const restoredThoughtLevel =
      readThoughtLevels(params.readRuntimeCapabilities()).currentValue;
    if (originalThoughtLevel && restoredThoughtLevel !== originalThoughtLevel) {
      await params.client.setRuntimeOption({
        sessionId: params.sessionId,
        source: "configOption",
        optionId: thoughtLevelOption.id,
        value: originalThoughtLevel,
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

type ModelThoughtLevels = {
  values: string[];
  currentValue?: string;
};

// A model switch keeps the session's thought level, and Kimi Code 2.0.0 lists
// that level in the new model's menu even when the model does not offer it:
// K2.7 reached from K3 at "high" shows {on, high}. Writing the carried level
// back while the menu still lists it settles which case applies. A model that
// does not offer the level refuses the write (K2.7), and one that accepts it
// replies with the level it applied, with the carried level gone from the
// menu once it is no longer current (K3 turns "on" into its own "high").
async function settleCarriedThoughtLevel(
  params: DiscoverySession,
  thoughtLevelOptionId: string,
): Promise<ModelThoughtLevels> {
  const switched = readThoughtLevels(params.readRuntimeCapabilities());
  const carried = switched.currentValue;
  if (
    !carried
    || !switched.values.includes(carried)
    || switched.values.length < 2
  ) {
    return switched;
  }

  try {
    await params.client.setRuntimeOption({
      sessionId: params.sessionId,
      source: "configOption",
      optionId: thoughtLevelOptionId,
      value: carried,
    });
  } catch {
    // Only the carried level can be foreign to this model, so the others are
    // what it offers. Which of them it would pick for itself is unknown.
    return {
      values: switched.values.filter((value) => value !== carried),
    };
  }
  return readThoughtLevels(params.readRuntimeCapabilities());
}

function readThoughtLevels(
  capabilities: BackendAcpRuntimeCapabilities | undefined,
): ModelThoughtLevels {
  const option = findConfigOption(capabilities, "thought_level");
  return {
    values: option?.values.map((value) => value.value) ?? [],
    ...(option?.currentValue ? { currentValue: option.currentValue } : {}),
  };
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
