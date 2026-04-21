import fs from "node:fs";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { ReplayClient } from "./replay-client";
import type { ReplayFixture, ReplayStepOverride } from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGNT_REPLAY_FIXTURE_PATH";

type ReplayDriver = {
  advance(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    stepId?: string;
    override?: ReplayStepOverride;
  }): Promise<void>;
  getLastStartTurn(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }):
    | {
        threadId: string;
        input: AppServerTurnInputItem[];
        model?: string;
        collaborationMode?: AppServerCollaborationModeRequest;
        serviceTier?: string;
        reasoningEffort?: string;
        fastMode?: boolean;
      }
    | undefined;
  getPendingRequest(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }): AppServerPendingRequestNotification | undefined;
  respondToPendingRequest(params: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    requestId: string;
  }): Promise<void>;
};

type ReplayRuntimeClient = {
  advance?(params?: {
    stepId?: string;
    override?: ReplayStepOverride;
  }): Promise<void>;
  close(): Promise<void>;
  getPendingRequest?(): AppServerPendingRequestNotification | undefined;
  getLastStartTurnParams?():
    | {
        threadId: string;
        input: AppServerTurnInputItem[];
        model?: string;
        collaborationMode?: AppServerCollaborationModeRequest;
        serviceTier?: string;
        reasoningEffort?: string;
        fastMode?: boolean;
      }
    | undefined;
  getInitializeResult(): Promise<{
    serverInfo?: {
      name?: string;
      version?: string;
    };
    methods?: string[];
  }>;
  listThreads(params?: { filter?: string }): Promise<AppServerThreadSummary[]>;
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void;
  readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]>;
  startThread(params: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string; runId: string }>;
  interruptTurn(params: {
    threadId: string;
    runId: string;
  }): Promise<{ threadId: string; runId: string }>;
  respondToPendingRequest?(requestId: string): Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __PWRAGNT_REPLAY_DRIVER__: ReplayDriver | undefined;
}

export function createReplayClientsFromEnv():
  | {
      codexDefaultClient: ReplayRuntimeClient;
      codexFullAccessClient: ReplayRuntimeClient;
      grokClient: ReplayRuntimeClient;
      defaultBackend: AppServerBackendKind;
    }
  | undefined {
  const fixturePath = process.env[REPLAY_FIXTURE_PATH_ENV]?.trim();
  if (!fixturePath) {
    return undefined;
  }

  const fixture = loadReplayFixture(fixturePath);
  const clients = createReplayClients(fixture);

  globalThis.__PWRAGNT_REPLAY_DRIVER__ = {
    advance: async (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
        executionMode: params?.executionMode,
      });
      await client.advance?.({
        stepId: params?.stepId,
        override: params?.override,
      });
    },
    getPendingRequest: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
        executionMode: params?.executionMode,
      });
      return client.getPendingRequest?.();
    },
    getLastStartTurn: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
        executionMode: params?.executionMode,
      });
      return client.getLastStartTurnParams?.();
    },
    respondToPendingRequest: async (params) => {
      const client = getReplayClient(clients, {
        backend: params.backend,
        executionMode: params.executionMode,
      });
      await client.respondToPendingRequest?.(params.requestId);
    }
  };

  return clients;
}

function createReplayClients(fixture: ReplayFixture): {
  codexDefaultClient: ReplayRuntimeClient;
  codexFullAccessClient: ReplayRuntimeClient;
  grokClient: ReplayRuntimeClient;
  defaultBackend: AppServerBackendKind;
} {
  if (fixture.metadata.backend === "grok") {
    const grokClient = ReplayClient.fromFixture(fixture);

    return {
      codexDefaultClient: createUnavailableReplayClient("codex", "grok"),
      codexFullAccessClient: createUnavailableReplayClient("codex", "grok"),
      grokClient,
      defaultBackend: "grok",
    };
  }

  return {
    codexDefaultClient: ReplayClient.fromFixture(fixture),
    codexFullAccessClient: ReplayClient.fromFixture(fixture),
    grokClient: createUnavailableReplayClient("grok", "codex"),
    defaultBackend: "codex",
  };
}

function getReplayClient(
  clients: {
    codexDefaultClient: ReplayRuntimeClient;
    codexFullAccessClient: ReplayRuntimeClient;
    grokClient: ReplayRuntimeClient;
    defaultBackend: AppServerBackendKind;
  },
  params: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }
): ReplayRuntimeClient {
  const backend = params.backend ?? clients.defaultBackend;
  if (backend === "grok") {
    return clients.grokClient;
  }

  return params.executionMode === "full-access"
    ? clients.codexFullAccessClient
    : clients.codexDefaultClient;
}

function loadReplayFixture(filePath: string): ReplayFixture {
  const contents = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(contents) as ReplayFixture;
  validateReplayFixture(parsed);
  return parsed;
}

function createUnavailableReplayClient(
  backend: AppServerBackendKind,
  activeBackend: AppServerBackendKind
): ReplayRuntimeClient {
  const message = `Replay fixture backend is ${activeBackend}; ${backend} is unavailable in replay mode.`;

  return {
    advance: async () => {
      throw new Error(message);
    },
    close: async () => undefined,
    getPendingRequest: () => undefined,
    getLastStartTurnParams: () => undefined,
    getInitializeResult: async () => {
      throw new Error(message);
    },
    listThreads: async () => {
      throw new Error(message);
    },
    listSkills: async () => {
      throw new Error(message);
    },
    onNotification: () => () => undefined,
    onRequest: () => () => undefined,
    readThread: async () => {
      throw new Error(message);
    },
    startThread: async () => {
      throw new Error(message);
    },
    startTurn: async () => {
      throw new Error(message);
    },
    interruptTurn: async () => {
      throw new Error(message);
    },
    respondToPendingRequest: async () => {
      throw new Error(message);
    },
  };
}
