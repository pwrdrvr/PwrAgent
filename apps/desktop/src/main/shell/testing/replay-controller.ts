import type {
  ReplayFixture,
  ReplayNotificationStep,
  ReplayRequestStep,
  ReplayResponseMethod,
  ReplayResponseStep,
  ReplayStep,
  ReplayStepOverride,
} from "../../testing/replay-fixture";
import {
  REUSABLE_RESPONSE_METHODS,
  responseReuseKey,
  validateReplayFixture,
} from "../../testing/replay-fixture";

type ReplayLiveStep = Exclude<ReplayStep, ReplayResponseStep>;

export type ReplayResponseSelector = {
  /** Select a `thread/list` step that answers archived listings. */
  archived?: boolean;
  /** Select a `thread/read` step scripted for this thread, or an unkeyed one. */
  threadId?: string;
  /** Select a `thread/read` step scripted for this older-page cursor. */
  before?: string;
};

export class ReplayController {
  private readonly steps: ReplayStep[];
  private index = 0;
  private readonly pendingRequests = new Map<string, ReplayRequestStep>();
  private readonly completedResponses = new Set<string>();
  private readonly reusableResponses = new Map<string, ReplayResponseStep>();

  constructor(private readonly fixture: ReplayFixture) {
    validateReplayFixture(fixture);
    this.steps = [...fixture.steps];
  }

  consumeResponse(
    method: ReplayResponseMethod,
    selector: ReplayResponseSelector = {}
  ): ReplayResponseStep {
    const response = this.tryConsumeResponse(method, selector);
    if (response) {
      return response;
    }

    const requested = describeResponse(method, selector);
    const nextStep = this.steps[this.index];
    if (!nextStep) {
      throw new Error(`Replay fixture exhausted before ${requested}`);
    }

    if (nextStep.kind !== "response") {
      throw new Error(
        `Replay fixture expected live step ${nextStep.id} before response ${requested}`
      );
    }

    throw new Error(
      `Replay fixture expected ${describeResponse(nextStep.method, nextStep)} before ${requested}`
    );
  }

  /** Like `consumeResponse`, but answers `undefined` when nothing is servable. */
  tryConsumeResponse(
    method: ReplayResponseMethod,
    selector: ReplayResponseSelector = {}
  ): ReplayResponseStep | undefined {
    const archived = selector.archived === true;
    const reuseKey = responseReuseKey({ method, archived });
    const matchIndex = this.findResponseIndex(method, archived, selector);
    if (matchIndex !== -1) {
      const [matchedStep] = this.steps.splice(matchIndex, 1);
      if (!matchedStep || matchedStep.kind !== "response") {
        throw new Error(`Replay fixture could not resolve response ${method}`);
      }

      if (REUSABLE_RESPONSE_METHODS.has(method)) {
        this.reusableResponses.set(responseReuseKey(matchedStep), matchedStep);
        // An older page never answers a request for the newest one.
        if (matchedStep.before === undefined) this.reusableResponses.set(reuseKey, matchedStep);
      }

      if (matchedStep.error) {
        throw new Error(
          `Replay response error (${matchedStep.error.code ?? "unknown"}): ${
            matchedStep.error.message ?? "unknown error"
          }`
        );
      }

      this.completedResponses.add(matchedStep.id);
      return matchedStep;
    }

    // The most specific answer wins: this thread's page, then any thread's
    // page, then this thread's newest page, then the last newest-page read.
    const { threadId, before } = selector;
    const keys = new Set([
      responseReuseKey({ method, archived, threadId, before }),
      responseReuseKey({ method, archived, before }),
      responseReuseKey({ method, archived, threadId }),
      reuseKey,
    ]);
    for (const key of keys) {
      const reused = this.reusableResponses.get(key);
      if (reused) return reused;
    }
    return undefined;
  }

  advance(params: {
    stepId?: string;
    override?: ReplayStepOverride;
  } = {}): ReplayLiveStep {
    const nextStep = this.steps[this.index];
    const pendingRequest = this.getPendingRequest();
    // Concurrent requests are independent owners. Notifications still wait
    // for all answers, preserving the fixture's response boundary.
    if (pendingRequest && nextStep?.kind !== "request") {
      throw new Error(
        `Replay is waiting for request ${pendingRequest.request.params.requestId}`
      );
    }

    if (!nextStep) {
      throw new Error("Replay has no remaining live steps");
    }
    if (nextStep.kind === "response") {
      throw new Error(
        `Replay fixture expected response ${nextStep.method} before live step ${params.stepId ?? "advance"}`
      );
    }
    if (params.stepId && nextStep.id !== params.stepId) {
      throw new Error(`Replay expected step ${nextStep.id} before ${params.stepId}`);
    }

    const merged = applyOverride(nextStep, params.override);
    if (merged.kind === "request" && this.pendingRequests.has(merged.request.params.requestId)) {
      throw new Error(`Replay request ${merged.request.params.requestId} is already pending`);
    }
    this.index += 1;

    if (merged.kind === "request") {
      this.pendingRequests.set(merged.request.params.requestId, merged);
    }

    return merged;
  }

  getPendingRequest(): ReplayRequestStep | undefined {
    let latest: ReplayRequestStep | undefined;
    for (const pending of this.pendingRequests.values()) latest = pending;
    return latest;
  }

  resolvePendingRequest(requestId: string): ReplayRequestStep {
    const current = this.pendingRequests.get(requestId);
    if (!current) {
      throw new Error(`Replay has no pending request ${requestId}`);
    }

    this.pendingRequests.delete(requestId);
    return current;
  }

  private findResponseIndex(
    method: ReplayResponseMethod,
    archived: boolean,
    selector: ReplayResponseSelector
  ): number {
    for (let candidateIndex = this.index; candidateIndex < this.steps.length; candidateIndex += 1) {
      const step = this.steps[candidateIndex];
      if (step.kind !== "response") {
        break;
      }
      if (step.method !== method || (step.archived === true) !== archived) continue;
      if (step.threadId !== undefined && step.threadId !== selector.threadId) continue;
      if (step.before !== undefined && step.before !== selector.before) continue;
      if (step.afterResponseId && !this.completedResponses.has(step.afterResponseId)) return -1;
      return candidateIndex;
    }

    return -1;
  }
}

function describeResponse(method: ReplayResponseMethod, selector: ReplayResponseSelector): string {
  if (selector.archived) return `${method} (archived)`;
  const scope = [selector.threadId, selector.before && `before ${selector.before}`].filter(Boolean);
  return scope.length ? `${method} (${scope.join(", ")})` : method;
}

function applyOverride(
  step: ReplayLiveStep,
  override?: ReplayStepOverride
): ReplayLiveStep {
  if (!override) {
    return step;
  }

  if ("request" in override && step.kind === "request") {
    const requestOverride = override.request;
    const requestParamsOverride = requestOverride?.params as
      | Record<string, unknown>
      | undefined;
    const request: ReplayRequestStep["request"] = {
      ...step.request,
      ...requestOverride,
      params: {
        ...(step.request.params as Record<string, unknown>),
        ...(requestParamsOverride ?? {})
      } as ReplayRequestStep["request"]["params"]
    };

    return {
      ...step,
      request
    };
  }

  if ("notification" in override && step.kind === "notification") {
    const notificationOverride = override.notification;
    const notificationParamsOverride = notificationOverride?.params as
      | Record<string, unknown>
      | undefined;
    const notification: ReplayNotificationStep["notification"] = {
      ...step.notification,
      ...notificationOverride,
      params: {
        ...(step.notification.params as Record<string, unknown>),
        ...(notificationParamsOverride ?? {})
      }
    } as ReplayNotificationStep["notification"];

    return {
      ...step,
      notification
    };
  }

  return {
    ...step,
    ...override
  } as ReplayLiveStep;
}
