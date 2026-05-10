import fs from "node:fs";
import type {
  AppServerBackendKind,
  AppServerCollaborationModeRequest,
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReviewDelivery,
  AppServerReviewTarget,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
  AppServerTurnInputItem,
  ThreadExecutionMode,
} from "@pwragent/shared";
import { ReplayClient } from "./replay-client";
import type { ReplayFixture, ReplayStepOverride } from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

const REPLAY_FIXTURE_PATH_ENV = "PWRAGENT_REPLAY_FIXTURE_PATH";

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
  getLastStartReview(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }):
    | {
        threadId: string;
        target: AppServerReviewTarget;
        delivery?: AppServerReviewDelivery;
      }
    | undefined;
  getLastRenameThread(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }):
    | {
        threadId: string;
        name: string;
      }
    | undefined;
  getInterruptTurnCalls(params?: {
    backend?: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
  }): Array<{
    threadId: string;
    turnId: string;
  }>;
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
  getLastStartReviewParams?():
    | {
        threadId: string;
        target: AppServerReviewTarget;
        delivery?: AppServerReviewDelivery;
      }
    | undefined;
  getLastRenameThreadParams?():
    | {
        threadId: string;
        name: string;
      }
    | undefined;
  getInterruptTurnCalls?(): Array<{
    threadId: string;
    turnId: string;
  }>;
  getInitializeResult(): Promise<{
    serverInfo?: {
      name?: string;
      version?: string;
    };
    methods?: string[];
  }>;
  listThreads(params?: {
    archived?: boolean;
    filter?: string;
  }): Promise<AppServerThreadSummary[]>;
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
  archiveThread?(params: {
    threadId: string;
  }): Promise<{ threadId: string }>;
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
  }): Promise<{ threadId: string; turnId: string }>;
  startReview(params: {
    threadId: string;
    target: AppServerReviewTarget;
    delivery?: AppServerReviewDelivery;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }>;
  interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  renameThread?(params: {
    threadId: string;
    name: string;
  }): Promise<{ threadId: string }>;
  respondToPendingRequest?(requestId: string): Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __PWRAGENT_REPLAY_DRIVER__: ReplayDriver | undefined;
}

export function createReplayClientsFromEnv():
  | {
      codexClient: ReplayRuntimeClient;
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

  // Note: the driver API still accepts `executionMode` on every method
  // for E2E backward-compat with existing replay specs. After the
  // single-instance collapse the param is ignored — there is only one
  // codex replay client serving both modes.
  globalThis.__PWRAGENT_REPLAY_DRIVER__ = {
    advance: async (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      await client.advance?.({
        stepId: params?.stepId,
        override: params?.override,
      });
    },
    getPendingRequest: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      return client.getPendingRequest?.();
    },
    getLastStartTurn: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      return client.getLastStartTurnParams?.();
    },
    getLastStartReview: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      return client.getLastStartReviewParams?.();
    },
    getLastRenameThread: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      return client.getLastRenameThreadParams?.();
    },
    getInterruptTurnCalls: (params) => {
      const client = getReplayClient(clients, {
        backend: params?.backend,
      });
      return client.getInterruptTurnCalls?.() ?? [];
    },
    respondToPendingRequest: async (params) => {
      const client = getReplayClient(clients, {
        backend: params.backend,
      });
      await client.respondToPendingRequest?.(params.requestId);
    }
  };

  return clients;
}

function createReplayClients(fixture: ReplayFixture): {
  codexClient: ReplayRuntimeClient;
  grokClient: ReplayRuntimeClient;
  defaultBackend: AppServerBackendKind;
} {
  if (fixture.metadata.backend === "grok") {
    const grokClient = ReplayClient.fromFixture(fixture);

    return {
      codexClient: createUnavailableReplayClient("codex", "grok"),
      grokClient,
      defaultBackend: "grok",
    };
  }

  return {
    codexClient: ReplayClient.fromFixture(fixture),
    grokClient: createUnavailableReplayClient("grok", "codex"),
    defaultBackend: "codex",
  };
}

function getReplayClient(
  clients: {
    codexClient: ReplayRuntimeClient;
    grokClient: ReplayRuntimeClient;
    defaultBackend: AppServerBackendKind;
  },
  params: {
    backend?: AppServerBackendKind;
  }
): ReplayRuntimeClient {
  const backend = params.backend ?? clients.defaultBackend;
  if (backend === "grok") {
    return clients.grokClient;
  }

  return clients.codexClient;
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
    getLastStartReviewParams: () => undefined,
    getLastRenameThreadParams: () => undefined,
    getInterruptTurnCalls: () => [],
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
    startReview: async () => {
      throw new Error(message);
    },
    interruptTurn: async () => {
      throw new Error(message);
    },
    renameThread: async () => {
      throw new Error(message);
    },
    respondToPendingRequest: async () => {
      throw new Error(message);
    },
  };
}
