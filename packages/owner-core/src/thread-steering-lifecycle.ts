import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  SteerTurnRequest,
  SteerTurnResponse,
} from "@pwragent/shared";

export type ThreadSteeringSubmission = {
  response: SteerTurnResponse;
  complete?: () => Promise<void>;
};

export interface ThreadSteeringLifecycleHost {
  submit(params: SteerTurnRequest, origin?: AppServerThreadMessageOrigin): Promise<ThreadSteeringSubmission>;
  complete(params: SteerTurnRequest, result: SteerTurnResponse, origin?: AppServerThreadMessageOrigin): Promise<void>;
}

export type ThreadSteeringLifecyclePorts = Pick<ThreadSteeringLifecycleHost, "submit">
  & Partial<Pick<ThreadSteeringLifecycleHost, "complete">>;

type AcceptedSteer = {
  params: SteerTurnRequest;
  origin?: AppServerThreadMessageOrigin;
  signature: string;
  submission?: ThreadSteeringSubmission;
  completion?: Promise<SteerTurnResponse>;
};

/** Optional ancestry must not change the identity of an old peer's retry. */
export function withoutTurnAttribution(
  origin?: AppServerThreadMessageOrigin,
): AppServerThreadMessageOrigin | undefined {
  if (!origin?.sourceThread) return origin;
  const { turnId: _turnId, rootTurnId: _rootTurnId, ...sourceThread } = origin.sourceThread;
  return { ...origin, sourceThread };
}

function signature(params: SteerTurnRequest, origin?: AppServerThreadMessageOrigin): string {
  return createHash("sha256")
    .update(JSON.stringify({
      input: params.input,
      messageOrigin: withoutTurnAttribution(origin) ?? null,
      // An interrupt and a steer of the same text are different requests.
      ...(params.delivery === "now" ? { delivery: "now" } : {}),
    }))
    .digest("hex");
}

function turnKey(params: { backend: AppServerBackendKind; threadId: string; turnId: string }): string {
  return JSON.stringify([params.backend, params.threadId, params.turnId]);
}

/** Process-local request admission. Providers remain authoritative for turns. */
export class ThreadSteeringLifecycle {
  private readonly turns = new Map<string, Map<string, AcceptedSteer>>();

  constructor(private readonly host: ThreadSteeringLifecyclePorts) {}

  async steerTurn(params: SteerTurnRequest, origin?: AppServerThreadMessageOrigin): Promise<SteerTurnResponse> {
    const key = turnKey({ ...params, turnId: params.expectedTurnId });
    let requests = this.turns.get(key);
    if (!requests) {
      requests = new Map();
      this.turns.set(key, requests);
    }
    const requestSignature = signature(params, origin);
    let accepted = requests.get(params.requestId);
    if (accepted && accepted.signature !== requestSignature) {
      throw new Error(`Steer request id ${params.requestId} was reused with different input`);
    }
    if (!accepted) {
      accepted = { params, origin, signature: requestSignature };
      requests.set(params.requestId, accepted);
    }
    if (!accepted.completion) {
      const entry = accepted;
      const admittedRequests = requests;
      // Admit before invoking the host, including synchronous reentrant calls.
      const completion = Promise.resolve().then(async () => {
        if (!entry.submission) {
          try {
            entry.submission = await this.host.submit(entry.params, entry.origin);
          } catch (error) {
            // A late failure must never evict a newer admission after retirement.
            if (admittedRequests.get(params.requestId) === entry) {
              admittedRequests.delete(params.requestId);
              if (admittedRequests.size === 0 && this.turns.get(key) === admittedRequests) this.turns.delete(key);
            }
            throw error;
          }
        }
        // Acceptance precedes host retention/persistence. A failure here must
        // retry this effect, never the provider. Clear only a completed effect.
        await entry.submission.complete?.();
        entry.submission.complete = undefined;
        await this.host.complete?.(entry.params, entry.submission.response, entry.origin);
        return entry.submission.response;
      });
      entry.completion = completion;
      // An accepted provider result survives host completion failure. A retry
      // repeats completion only, and every concurrent caller observes it.
      void completion.catch(() => {
        if (entry.completion === completion) entry.completion = undefined;
      });
    }
    return await accepted.completion!;
  }

  retireTurn(params: { backend: AppServerBackendKind; threadId: string; turnId: string }): void {
    this.turns.delete(turnKey(params));
  }

  clear(): void {
    this.turns.clear();
  }
}
