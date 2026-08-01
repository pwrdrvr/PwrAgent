import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerTurnInputItem,
  ThreadOverlayState,
} from "@pwragent/shared";
import { parseThreadIdentityKey } from "@pwragent/shared";
import type { PrStatusTransition } from "./pr-transitions";

export const MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT = 2;

export type PrAutoDispatchOutcome = {
  threadKey: string;
  status:
    | "dispatched"
    | "gate-off"
    | "not-actionable"
    | "missing-head"
    | "disabled"
    | "busy"
    | "pending"
    | "duplicate"
    | "attempt-limit"
    | "failed";
  fingerprint?: string;
  error?: string;
};

type PrAutoDispatchStore = {
  getThreadOverlayState(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadOverlayState | undefined>;
  claimThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    fingerprint: string;
    maxAttempts: number;
  }): Promise<{
    claimed: boolean;
    reason?: "disabled" | "duplicate" | "attempt-limit";
    attemptCount: number;
  }>;
  resetThreadPrAutoDispatchIncident(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
  }): Promise<void>;
};

type PrAutoDispatchRegistry = {
  canStartThreadTurnImmediately(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean;
  submitTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: "automation";
    messageOrigin: { kind: "pwragent" };
  }): Promise<unknown>;
};

type PrAutoDispatchEvent = {
  eventKinds: Array<"ci-failure" | "merge-conflict">;
  fingerprint: string;
  headSha: string;
};

export class PrAutoDispatchCoordinator {
  private readonly pendingThreadKeys = new Set<string>();

  constructor(
    private readonly options: {
      store: PrAutoDispatchStore;
      registry: PrAutoDispatchRegistry;
      isBackgroundPollingEnabled?: () => boolean;
    },
  ) {}

  async handleTransition(params: {
    transition: PrStatusTransition;
    source: string;
    observedAt: number;
    backgroundPollingEnabled: boolean;
  }): Promise<PrAutoDispatchOutcome[]> {
    const threadKeys = params.transition.threadKeys;
    if (
      !params.backgroundPollingEnabled
      || params.source !== "background-poll"
    ) {
      return threadKeys.map((threadKey) => ({ threadKey, status: "gate-off" }));
    }

    if (prIsHealthy(params.transition)) {
      await Promise.all(
        threadKeys.map(async (threadKey) => {
          const identity = parseThreadIdentityKey(threadKey);
          if (!identity) return;
          await this.options.store.resetThreadPrAutoDispatchIncident({
            ...identity,
            prKey: params.transition.prKey,
          });
        }),
      );
    }

    const event = buildPrAutoDispatchEvent(params.transition);
    if (!event) {
      const becameActionable =
        params.transition.changed.checkState?.to === "failing"
        || params.transition.changed.mergeState?.to === "conflicting";
      const status = becameActionable ? "missing-head" : "not-actionable";
      return threadKeys.map((threadKey) => ({ threadKey, status }));
    }

    const outcomes: PrAutoDispatchOutcome[] = [];
    for (const threadKey of threadKeys) {
      outcomes.push(await this.dispatchForThread({
        event,
        observedAt: params.observedAt,
        threadKey,
        transition: params.transition,
      }));
    }
    return outcomes;
  }

  private async dispatchForThread(params: {
    event: PrAutoDispatchEvent;
    observedAt: number;
    threadKey: string;
    transition: PrStatusTransition;
  }): Promise<PrAutoDispatchOutcome> {
    const identity = parseThreadIdentityKey(params.threadKey);
    if (!identity) {
      return { threadKey: params.threadKey, status: "disabled" };
    }
    if (this.pendingThreadKeys.has(params.threadKey)) {
      return {
        threadKey: params.threadKey,
        status: "pending",
        fingerprint: params.event.fingerprint,
      };
    }

    this.pendingThreadKeys.add(params.threadKey);
    try {
      if (this.options.isBackgroundPollingEnabled?.() === false) {
        return { threadKey: params.threadKey, status: "gate-off" };
      }
      const overlay = await this.options.store.getThreadOverlayState(identity);
      if (overlay?.prAutoDispatchEnabled !== true) {
        return { threadKey: params.threadKey, status: "disabled" };
      }
      if (!this.options.registry.canStartThreadTurnImmediately(identity)) {
        return {
          threadKey: params.threadKey,
          status: "busy",
          fingerprint: params.event.fingerprint,
        };
      }
      if (this.options.isBackgroundPollingEnabled?.() === false) {
        return { threadKey: params.threadKey, status: "gate-off" };
      }

      const claim = await this.options.store.claimThreadPrAutoDispatch({
        ...identity,
        prKey: params.transition.prKey,
        fingerprint: params.event.fingerprint,
        maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
      });
      if (!claim.claimed) {
        return {
          threadKey: params.threadKey,
          status: claim.reason ?? "disabled",
          fingerprint: params.event.fingerprint,
        };
      }

      try {
        if (this.options.isBackgroundPollingEnabled?.() === false) {
          return {
            threadKey: params.threadKey,
            status: "gate-off",
            fingerprint: params.event.fingerprint,
          };
        }
        await this.options.registry.submitTurn({
          ...identity,
          input: [{
            type: "text",
            text: buildPrAutoDispatchPrompt({
              ...params,
              attemptCount: claim.attemptCount,
            }),
          }],
          origin: "automation",
          messageOrigin: { kind: "pwragent" },
        });
        return {
          threadKey: params.threadKey,
          status: "dispatched",
          fingerprint: params.event.fingerprint,
        };
      } catch (error) {
        return {
          threadKey: params.threadKey,
          status: "failed",
          fingerprint: params.event.fingerprint,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      this.pendingThreadKeys.delete(params.threadKey);
    }
  }
}

export function buildPrAutoDispatchEvent(
  transition: PrStatusTransition,
): PrAutoDispatchEvent | undefined {
  const eventKinds: PrAutoDispatchEvent["eventKinds"] = [];
  const headChanged = transition.changed.headSha !== undefined;
  if (
    transition.changed.checkState?.to === "failing"
    || (headChanged && transition.pr.checkState === "failing")
  ) {
    eventKinds.push("ci-failure");
  }
  if (
    transition.changed.mergeState?.to === "conflicting"
    || (headChanged && transition.pr.mergeState === "conflicting")
  ) {
    eventKinds.push("merge-conflict");
  }
  if (eventKinds.length === 0) {
    return undefined;
  }

  const headSha = transition.headSha ?? transition.pr.headSha;
  if (!headSha) {
    return undefined;
  }
  const fingerprintPayload = {
    version: 1,
    prKey: transition.prKey,
    headSha,
    eventKinds,
    checkState: eventKinds.includes("ci-failure")
      ? transition.pr.checkState
      : undefined,
    mergeState: eventKinds.includes("merge-conflict")
      ? transition.pr.mergeState
      : undefined,
  };
  return {
    eventKinds,
    headSha,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintPayload))
      .digest("hex"),
  };
}

function prIsHealthy(transition: PrStatusTransition): boolean {
  return (
    transition.pr.checkState !== "failing"
    && transition.pr.mergeState !== "conflicting"
  );
}

function buildPrAutoDispatchPrompt(params: {
  attemptCount: number;
  event: PrAutoDispatchEvent;
  observedAt: number;
  transition: PrStatusTransition;
}): string {
  const changes = Object.entries(params.transition.changed)
    .map(([field, change]) =>
      `${field}: ${String(change?.from ?? "unknown")} -> ${String(change?.to ?? "unknown")}`,
    )
    .join("\n");
  return [
    "PwrAgent automatically dispatched this bounded repair turn because an attached pull request entered an actionable state.",
    "",
    "Pull request event",
    `- PR: ${params.transition.prKey}`,
    `- URL: ${params.transition.url}`,
    `- Title: ${params.transition.title ?? "(untitled)"}`,
    `- Head SHA: ${params.event.headSha}`,
    `- Event kinds: ${params.event.eventKinds.join(", ")}`,
    `- Check state: ${params.transition.pr.checkState ?? "unknown"}`,
    `- Merge state: ${params.transition.pr.mergeState ?? "unknown"}`,
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    `- Automatic attempt: ${params.attemptCount}/${MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT}`,
    `- Dedupe fingerprint: ${params.event.fingerprint}`,
    "",
    "Observed transition",
    changes || "(no details)",
    "",
    "Investigate the current PR checks or merge conflict, make only scoped fixes, run relevant validation, and update the attached PR when appropriate. Verify current provider state before changing code. If the condition is external, transient, or no safe fix is available, explain that and stop; do not create another retry loop.",
  ].join("\n");
}
