import type { ReplayFixture, ReplayRequestStep, ReplayResponseMethod, ReplayResponseStep, ReplayStep, ReplayStepOverride } from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

export class ReplayController {
  private readonly steps: ReplayStep[];
  private index = 0;
  private pendingRequest?: ReplayRequestStep;

  constructor(private readonly fixture: ReplayFixture) {
    validateReplayFixture(fixture);
    this.steps = fixture.steps;
  }

  consumeResponse(method: ReplayResponseMethod): ReplayResponseStep {
    const nextStep = this.steps[this.index];
    if (!nextStep) {
      throw new Error(`Replay fixture exhausted before ${method}`);
    }
    if (nextStep.kind !== "response") {
      throw new Error(
        `Replay fixture expected live step ${nextStep.id} before response ${method}`
      );
    }
    if (nextStep.method !== method) {
      throw new Error(
        `Replay fixture expected ${nextStep.method} before ${method}`
      );
    }

    this.index += 1;

    if (nextStep.error) {
      throw new Error(
        `Replay response error (${nextStep.error.code ?? "unknown"}): ${
          nextStep.error.message ?? "unknown error"
        }`
      );
    }

    return nextStep;
  }

  advance(params: {
    stepId?: string;
    override?: ReplayStepOverride;
  } = {}): Exclude<ReplayStep, ReplayResponseStep> {
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
}

function applyOverride<T extends Exclude<ReplayStep, ReplayResponseStep>>(
  step: T,
  override?: ReplayStepOverride
): T {
  if (!override) {
    return step;
  }

  if ("request" in override && step.kind === "request") {
    return {
      ...step,
      request: {
        ...step.request,
        ...override.request,
        params: {
          ...step.request.params,
          ...(override.request?.params ?? {})
        }
      }
    } as T;
  }

  if ("notification" in override && step.kind === "notification") {
    return {
      ...step,
      notification: {
        ...step.notification,
        ...override.notification,
        params: {
          ...step.notification.params,
          ...(override.notification?.params ?? {})
        }
      }
    } as T;
  }

  return {
    ...step,
    ...override
  } as T;
}
