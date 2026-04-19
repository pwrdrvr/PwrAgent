import type {
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
} from "@pwragnt/shared";

export type ReplayResponseMethod = string;

export type ReplayResponseStep = {
  id: string;
  kind: "response";
  method: ReplayResponseMethod;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type ReplayNotificationStep = {
  id: string;
  kind: "notification";
  notification: AppServerNotification;
};

export type ReplayRequestStep = {
  id: string;
  kind: "request";
  request: AppServerPendingRequestNotification;
};

export type ReplayStep = ReplayResponseStep | ReplayNotificationStep | ReplayRequestStep;

export type ReplayFixture = {
  metadata: {
    backend: "codex" | "grok";
    scenario: string;
    sourceCaptureId?: string;
    threadId?: string;
  };
  steps: ReplayStep[];
};

export type ReplayStepOverride = Partial<ReplayNotificationStep | ReplayRequestStep>;

export function validateReplayFixture(fixture: ReplayFixture): void {
  if (!fixture.metadata?.backend) {
    throw new Error("Replay fixture requires metadata.backend");
  }

  if (!fixture.metadata?.scenario?.trim()) {
    throw new Error("Replay fixture requires metadata.scenario");
  }

  if (!Array.isArray(fixture.steps)) {
    throw new Error("Replay fixture requires steps");
  }

  const ids = new Set<string>();
  for (const step of fixture.steps) {
    if (!step.id?.trim()) {
      throw new Error("Replay fixture step requires id");
    }
    if (ids.has(step.id)) {
      throw new Error(`Replay fixture step ids must be unique: ${step.id}`);
    }
    ids.add(step.id);

    if (step.kind === "response") {
      if (!step.method?.trim()) {
        throw new Error(`Replay response step ${step.id} requires method`);
      }
      if (
        !Object.hasOwn(step, "result")
        && !Object.hasOwn(step, "error")
      ) {
        throw new Error(
          `Replay response step ${step.id} requires result or error`
        );
      }
      continue;
    }

    if (step.kind === "notification") {
      if (!step.notification?.method?.trim()) {
        throw new Error(`Replay notification step ${step.id} requires notification.method`);
      }
      continue;
    }

    if (step.kind === "request") {
      if (!step.request?.method?.trim()) {
        throw new Error(`Replay request step ${step.id} requires request.method`);
      }
      if (!step.request?.params?.requestId || typeof step.request.params.requestId !== "string") {
        throw new Error(`Replay request step ${step.id} requires params.requestId`);
      }
      continue;
    }

    throw new Error("Replay fixture contains an unsupported step kind");
  }
}

export function asInitializeResult(
  value: unknown
): {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
} {
  return (value ?? {}) as {
    serverInfo?: {
      name?: string;
      version?: string;
    };
    methods?: string[];
  };
}

export function asThreadList(value: unknown): AppServerThreadSummary[] {
  return Array.isArray(value) ? (value as AppServerThreadSummary[]) : [];
}

export function asSkillList(
  value: unknown
): AppServerListSkillsResponse["data"] {
  return Array.isArray(value)
    ? (value as AppServerListSkillsResponse["data"])
    : [];
}

export function asThreadReplay(
  value: unknown
): AppServerReadThreadResponse["replay"] {
  return value as AppServerReadThreadResponse["replay"];
}
