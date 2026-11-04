import { isDeepStrictEqual } from "node:util";
import type {
  AppServerListSkillsResponse,
  AppServerNotification,
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
  AppServerThreadSummary,
} from "@pwragent/shared";

export type ReplayResponseMethod = string;

export type ReplayResponseStep = {
  id: string;
  kind: "response";
  method: ReplayResponseMethod;
  /** Reuse the preceding response until this causal response has completed. */
  afterResponseId?: string;
  /**
   * `thread/list` only: answer archived listings instead of active ones.
   * Archived listings are empty until a fixture scripts one, as Codex moves
   * an archived thread out of the active listing and into the archived one.
   */
  archived?: boolean;
  /**
   * `thread/read` only: answer reads of this thread and no other. Without it,
   * reads are answered in fixture order, whichever thread they ask for.
   */
  threadId?: string;
  /**
   * `thread/read` only: answer the older page requested with this cursor.
   * Without it, the read can answer a request for any page.
   */
  before?: string;
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
    backend: "codex";
    scenario: string;
    sourceCaptureId?: string;
    threadId?: string;
  };
  steps: ReplayStep[];
};

export type ReplayStepOverride = Partial<ReplayNotificationStep | ReplayRequestStep>;

/**
 * Methods the app calls again on its own (startup, polls, refreshes). The
 * controller keeps answering one with its last consumed response.
 */
export const REUSABLE_RESPONSE_METHODS: ReadonlySet<ReplayResponseMethod> = new Set([
  "initialize",
  "thread/list",
  "thread/read",
  "skills/list",
]);

/** Which calls a response can answer: one listing, or one page of a thread. */
export function responseReuseKey(
  step: Pick<ReplayResponseStep, "method" | "archived" | "threadId" | "before">
): string {
  let key = step.archived === true ? `${step.method}#archived` : step.method;
  if (step.threadId !== undefined) key += `@${step.threadId}`;
  if (step.before !== undefined) key += `<${step.before}`;
  return key;
}

/**
 * A run of response steps is served in any order, and a reusable method's
 * answers are served in fixture order to however many calls arrive. An extra
 * refresh can therefore take a later answer before the action that it
 * describes. Each later answer that differs must wait for the response that
 * causes it. Reads of other threads or pages say which one each answers.
 */
function validateResponseBlockCausality(fixture: ReplayFixture): void {
  let previousByKey = new Map<string, ReplayResponseStep>();
  let threadReadKeying: { keyed: boolean; id: string } | undefined;
  for (const step of fixture.steps) {
    if (step.kind !== "response") {
      previousByKey = new Map();
      threadReadKeying = undefined;
      continue;
    }
    if (!REUSABLE_RESPONSE_METHODS.has(step.method)) continue;

    if (step.method === "thread/read") {
      // An unkeyed read answers any thread, so it could answer a keyed
      // thread's refresh after that thread's own read.
      const keyed = step.threadId !== undefined;
      threadReadKeying ??= { keyed, id: step.id };
      if (threadReadKeying.keyed !== keyed) {
        throw new Error(
          `Replay response ${step.id} and ${threadReadKeying.id} share a response block;`
          + " set threadId on every thread/read in it or on none"
        );
      }
    }

    const key = responseReuseKey(step);
    const previous = previousByKey.get(key);
    previousByKey.set(key, step);
    if (!previous || step.afterResponseId || sameAnswer(previous, step)) continue;
    throw new Error(
      `Replay response ${step.id} is a second ${key} answer after ${previous.id}`
      + " in one response block; set afterResponseId to the response that changes it"
      + (step.method === "thread/read"
        ? ", or threadId or before when it reads another thread or page"
        : "")
    );
  }
}

function sameAnswer(left: ReplayResponseStep, right: ReplayResponseStep): boolean {
  return isDeepStrictEqual(left.result, right.result)
    && isDeepStrictEqual(left.error, right.error);
}

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
      if (step.afterResponseId && !fixture.steps.some((candidate) => candidate.kind === "response"
        && candidate.id === step.afterResponseId && candidate.id !== step.id)) {
        throw new Error(`Replay response ${step.id} references an unknown causal response`);
      }
      if (!step.method?.trim()) {
        throw new Error(`Replay response step ${step.id} requires method`);
      }
      if (step.archived !== undefined && step.method !== "thread/list") {
        throw new Error(`Replay response ${step.id} sets archived, which only thread/list answers`);
      }
      for (const field of ["threadId", "before"] as const) {
        const value = step[field];
        if (value !== undefined && (step.method !== "thread/read" || !value.trim())) {
          throw new Error(`Replay response ${step.id} sets ${field}, which only thread/read answers`);
        }
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

  validateResponseBlockCausality(fixture);
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
