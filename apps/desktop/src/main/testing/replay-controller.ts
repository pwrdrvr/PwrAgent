import type {
  ReplayFixture,
  ReplayNotificationStep,
  ReplayRequestStep,
  ReplayResponseMethod,
  ReplayResponseStep,
  ReplayStep,
  ReplayStepOverride,
} from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

type ReplayLiveStep = Exclude<ReplayStep, ReplayResponseStep>;

const REUSABLE_RESPONSE_METHODS = new Set<ReplayResponseMethod>([
  "initialize",
  "thread/list",
  "thread/read",
  "skills/list",
]);

export class ReplayController {
  private readonly steps: ReplayStep[];
  private index = 0;
  private pendingRequest?: ReplayRequestStep;
  private readonly reusableResponses = new Map<
    ReplayResponseMethod,
    ReplayResponseStep
  >();

  constructor(private readonly fixture: ReplayFixture) {
    validateReplayFixture(fixture);
    this.steps = [...fixture.steps];
  }

  consumeResponse(method: ReplayResponseMethod): ReplayResponseStep {
    const nextStep = this.steps[this.index];
    const matchIndex = this.findResponseIndex(method);
    if (matchIndex !== -1) {
      const [matchedStep] = this.steps.splice(matchIndex, 1);
      if (!matchedStep || matchedStep.kind !== "response") {
        throw new Error(`Replay fixture could not resolve response ${method}`);
      }

      if (REUSABLE_RESPONSE_METHODS.has(method)) {
        this.reusableResponses.set(method, matchedStep);
      }

      if (matchedStep.error) {
        throw new Error(
          `Replay response error (${matchedStep.error.code ?? "unknown"}): ${
            matchedStep.error.message ?? "unknown error"
          }`
        );
      }

      return matchedStep;
    }

    const cachedResponse = this.reusableResponses.get(method);
    if (cachedResponse) {
      return cachedResponse;
    }

    if (!nextStep) {
      throw new Error(`Replay fixture exhausted before ${method}`);
    }

    if (nextStep.kind !== "response") {
      throw new Error(
        `Replay fixture expected live step ${nextStep.id} before response ${method}`
      );
    }

    throw new Error(
      `Replay fixture expected ${nextStep.method} before ${method}`
    );
  }

  advance(params: {
    stepId?: string;
    override?: ReplayStepOverride;
  } = {}): ReplayLiveStep {
    if (this.pendingRequest) {
      throw new Error(
        `Replay is waiting for request ${this.pendingRequest.request.params.requestId}`
      );
    }

    const nextStep = this.steps[this.index];
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
    this.index += 1;

    if (merged.kind === "request") {
      this.pendingRequest = merged;
    }

    return merged;
  }

  getPendingRequest(): ReplayRequestStep | undefined {
    return this.pendingRequest;
  }

  resolvePendingRequest(requestId: string): ReplayRequestStep {
    if (!this.pendingRequest || this.pendingRequest.request.params.requestId !== requestId) {
      throw new Error(`Replay has no pending request ${requestId}`);
    }

    const current = this.pendingRequest;
    this.pendingRequest = undefined;
    return current;
  }

  private findResponseIndex(method: ReplayResponseMethod): number {
    for (let candidateIndex = this.index; candidateIndex < this.steps.length; candidateIndex += 1) {
      const step = this.steps[candidateIndex];
      if (step.kind !== "response") {
        break;
      }
      if (step.method === method) {
        return candidateIndex;
      }
    }

    return -1;
  }
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
