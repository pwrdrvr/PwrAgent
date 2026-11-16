import type { AgentEvent, AppServerPendingRequestNotification } from "@pwragent/shared";
import type { CodexStartDeliveryReceipt } from "./registry-turn-state";
import type { LiveThreadUsageEmitWork, ReviewSubAgentRecord } from "./backend-registry-types";

/** One notification's scratch state. Never shared between concurrent deliveries. */
export interface TurnEventDelivery {
  event: AgentEvent;
  readonly liveThreadUsageWork: LiveThreadUsageEmitWork | undefined;
  readonly precedingLiveThreadUsageBarrier: Promise<void> | undefined;
  readonly codexStatusSequence: number | undefined;
  readonly codexStartDelivery: CodexStartDeliveryReceipt | undefined;
  managedReview?: ReviewSubAgentRecord;
  lifecycleTurnId?: string;
  endedTurnIds?: Set<string>;
  withdrawnForgeApprovals?: AppServerPendingRequestNotification[];
}

/** False consumes this delivery, including listener fan-out; throws abort it. */
export type TurnEventHandler = (delivery: TurnEventDelivery) => void | false | Promise<void | false>;

/**
 * onEvent handles every protocol event, including transforms and accounting.
 * Lifecycle callbacks are selected by method, not by provider or activity.
 * A stage supplies either onEvent or the applicable lifecycle callbacks.
 * Awaited work, fire-and-forget work and local catch/finally boundaries belong
 * to the observer. The runner adds no error recovery or cross-delivery queue.
 */
export interface TurnEventObserver {
  readonly name: string;
  readonly onEvent?: TurnEventHandler;
  readonly onTurnStarted?: TurnEventHandler;
  readonly onTurnTerminal?: TurnEventHandler;
  readonly onStatusChanged?: TurnEventHandler;
}

export class TurnEventObservers {
  constructor(readonly observers: readonly TurnEventObserver[]) {}

  async run(
    event: AgentEvent,
    liveThreadUsageWork: LiveThreadUsageEmitWork | undefined,
    precedingLiveThreadUsageBarrier: Promise<void> | undefined,
    codexStatusSequence?: number,
    codexStartDelivery?: CodexStartDeliveryReceipt,
  ): Promise<void> {
    const delivery: TurnEventDelivery = {
      event, liveThreadUsageWork, precedingLiveThreadUsageBarrier, codexStatusSequence, codexStartDelivery,
    };
    for (const observer of this.observers) {
      const method = delivery.event.notification.method;
      const handler = observer.onEvent ?? (method === "turn/started" ? observer.onTurnStarted
        : method === "turn/completed" || method === "turn/failed" || method === "turn/cancelled" ? observer.onTurnTerminal
          : method === "thread/status/changed" ? observer.onStatusChanged : undefined);
      const result = handler?.(delivery);
      // Synchronous stages stay synchronous. In particular, a false result is
      // the old hub's early return, not merely a skip of this observer.
      if ((result instanceof Promise ? await result : result) === false) return;
    }
  }
}
