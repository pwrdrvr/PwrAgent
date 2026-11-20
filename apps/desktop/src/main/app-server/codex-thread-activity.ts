import type { AppServerCollaborationModeRequest } from "@pwragent/shared/contracts/agent";
import type {
  AppServerThreadStatus,
  ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { CodexRetryableOperation, PendingReviewStartRecord, ReviewSubAgentRecord, ReviewTerminal, StartingTurnOrigin } from "./backend-registry-types";

type ReviewAdmissionFields = Omit<PendingReviewStartRecord, "status" | "reviewThreadId" | "reviewTurnId" | "error">;
export type ReviewAdmission = ReviewAdmissionFields & (
  | { readonly status: "scheduled" | "starting" }
  | { readonly status: "started"; readonly reviewThreadId: string; readonly reviewTurnId: string }
  | { readonly status: "cancelled" | "failed"; readonly error: string }
);
export type ReviewStartAttempt = { readonly owner: object; readonly terminals: readonly ReviewTerminal[] };
export type ReviewChildLink = {
  readonly key: string;
  readonly parentBackend: ReviewSubAgentRecord["parentBackend"];
  readonly parentThreadId: string;
};
export type CodexOperationReceipt = Readonly<CodexRetryableOperation> & {
  readonly owner: object;
  readonly lifetime: "active" | "active-retained" | "settled-retained";
};
export type CodexOperationPatch = { readonly turnId?: string; readonly terminalObserved?: boolean; readonly lifecycleStarted?: boolean };

type ExecutionOwnership = { readonly mode: ThreadExecutionMode; readonly order: number };
type ReviewOwnership =
  | { readonly phase: "correlating"; readonly interruptTurnId: string; readonly interruptOrder: number }
  | { readonly phase: "active"; readonly order: number; readonly interruptTurnId?: string; readonly interruptOrder?: number };
type TurnCorrelation = {
  readonly turnId: string;
  readonly collaboration?: AppServerCollaborationModeRequest["mode"];
  readonly review?: ReviewOwnership;
};

/** A response and a notification need not identify the same native review turn. */
export type CodexTurnOwnership = TurnCorrelation & (
  | { readonly phase: "prepared"; readonly registration?: never; readonly execution?: never }
  | { readonly phase: "announced"; readonly registration: number; readonly execution?: ExecutionOwnership }
  | { readonly phase: "accepted" | "terminating"; readonly registration?: never; readonly execution: ExecutionOwnership }
);

export type CodexStartReservation = {
  readonly owner: object;
  readonly kind: "turn" | "review" | "compact" | "revert" | "voice" | "worker" | "workspace" | "agent";
};
export type CodexStatusObservation = { readonly sequence: number; readonly status: AppServerThreadStatus };
type ActivityEvidence = {
  readonly turns: readonly CodexTurnOwnership[];
  readonly reservation?: CodexStartReservation;
  readonly operations: readonly CodexOperationReceipt[];
  readonly deliveries: readonly { readonly owner: object; readonly turnId: string; readonly phase: "pending" | "terminal" }[];
  readonly providerStatus?: AppServerThreadStatus;
  readonly providerOrder?: number;
  readonly observation?: CodexStatusObservation;
  /** Survives acknowledgement of observation by thread/list. */
  readonly statusWatermark: number;
  readonly origins: readonly { readonly owner: StartingTurnOrigin; readonly value: StartingTurnOrigin; readonly order: number }[];
  readonly admissions: readonly ReviewAdmission[];
  readonly reviewStarts: readonly ReviewStartAttempt[];
  readonly liveReviews: readonly { readonly order: number; readonly record: ReviewSubAgentRecord }[];
  readonly reviewChildren: readonly ReviewChildLink[];
};

/**
 * One value per Codex thread. Registered turns, accepted mode ownership and
 * provider-discovered activity have different projections; retain their
 * evidence instead of inferring one from another. The reducer alone chooses
 * the activity phase. There are no mutable collection projections.
 */
export type CodexThreadActivity = ActivityEvidence & (
  | { readonly phase: "idle" }
  | { readonly phase: "reserved"; readonly owner: object; readonly kind: CodexStartReservation["kind"] }
  | { readonly phase: "started"; readonly source: "execution"; readonly turnId: string; readonly mode: ThreadExecutionMode; readonly review?: ReviewOwnership }
  | { readonly phase: "started"; readonly source: "provider"; readonly providerStatus: "active" }
  | { readonly phase: "started"; readonly source: "registration"; readonly turnId: string; readonly registration: number }
  | { readonly phase: "started"; readonly source: "review"; readonly review: ReviewSubAgentRecord }
  | { readonly phase: "terminating"; readonly turnId: string; readonly mode: ThreadExecutionMode; readonly review?: ReviewOwnership }
);

export type CodexThreadActivityEvent =
  | { type: "reserve"; reservation: CodexStartReservation }
  | { type: "release"; owner: object }
  | { type: "announced"; turnId: string; order: number; delivery?: object }
  | { type: "startDelivery"; turnId: string; owner: object }
  | { type: "finishDelivery"; owner: object }
  | { type: "terminalDelivery"; turnId: string }
  | { type: "unregistered"; turnId: string }
  | { type: "executionAccepted"; turnId: string; mode: ThreadExecutionMode; order: number }
  | { type: "executionResolved"; turnId: string; registration: number; mode: ThreadExecutionMode; order: number }
  | { type: "executionChanged"; turnId: string; mode: ThreadExecutionMode }
  | { type: "executionForgotten"; turnId: string }
  | { type: "collaboration"; turnId: string; mode?: AppServerCollaborationModeRequest["mode"] }
  | { type: "review"; turnId: string; active: boolean; order: number }
  | { type: "reviewInterrupt"; turnId: string; interruptTurnId?: string; order: number }
  | { type: "retry"; operation?: CodexRetryableOperation }
  | { type: "retryUpdated"; owner: object; patch: CodexOperationPatch }
  | { type: "retryReleased"; owner: object }
  | { type: "observe"; observation: CodexStatusObservation; order: number }
  | { type: "seed"; status?: AppServerThreadStatus; order: number }
  | { type: "acknowledgeObservation"; observation: CodexStatusObservation }
  | { type: "restoreObservation"; sequence: number; previous?: CodexStatusObservation; order: number }
  | { type: "originAdded"; origin: StartingTurnOrigin; order: number }
  | { type: "originRemoved"; origin: StartingTurnOrigin }
  | { type: "originBound"; origin: StartingTurnOrigin; turn: { threadId: string; turnId: string } }
  | { type: "reviewAdmission"; admission: ReviewAdmission }
  | { type: "reviewStartOpened"; owner: object }
  | { type: "reviewStartClosed"; owner: object }
  | { type: "reviewTerminal"; terminal: ReviewTerminal }
  | { type: "reviewActivated"; record: ReviewSubAgentRecord; order: number }
  | { type: "reviewFinished"; record: ReviewSubAgentRecord }
  | { type: "reviewChildLinked"; link: ReviewChildLink }
  | { type: "reviewChildUnlinked"; key: string };

export function idleCodexThreadActivity(): CodexThreadActivity {
  return { phase: "idle", turns: [], operations: [], deliveries: [], statusWatermark: 0, origins: [], admissions: [], reviewStarts: [], liveReviews: [], reviewChildren: [] };
}

export function activeCodexOperation(state: Pick<CodexThreadActivity, "operations">): CodexOperationReceipt | undefined {
  return state.operations.find(operation => operation.lifetime !== "settled-retained");
}

function classify(evidence: ActivityEvidence): CodexThreadActivity {
  // Strip the previous variant's discriminants when choosing the next one.
  evidence = {
    turns: evidence.turns, operations: evidence.operations, deliveries: evidence.deliveries, reservation: evidence.reservation,
    providerStatus: evidence.providerStatus, providerOrder: evidence.providerOrder,
    observation: evidence.observation, statusWatermark: evidence.statusWatermark, origins: evidence.origins,
    admissions: evidence.admissions, reviewStarts: evidence.reviewStarts, liveReviews: evidence.liveReviews, reviewChildren: evidence.reviewChildren,
  };
  if (evidence.liveReviews.length) return { ...evidence, phase: "started", source: "review", review: evidence.liveReviews[0]!.record };
  const executions = evidence.turns.filter(turn => turn.execution).sort((left, right) => left.execution!.order - right.execution!.order);
  if (executions.length) {
    const primary = executions[0]!;
    return executions.every(turn => turn.phase === "terminating") && evidence.providerStatus !== "active"
      ? { ...evidence, phase: "terminating", turnId: primary.turnId, mode: primary.execution!.mode, review: primary.review }
      : { ...evidence, phase: "started", source: "execution", turnId: primary.turnId, mode: primary.execution!.mode, review: primary.review };
  }
  if (evidence.providerStatus === "active") return { ...evidence, phase: "started", source: "provider", providerStatus: "active" };
  if (evidence.reservation) {
    return { ...evidence, phase: "reserved", kind: evidence.reservation.kind, owner: evidence.reservation.owner };
  }
  const operation = activeCodexOperation(evidence);
  if (operation?.kind === "compact") return { ...evidence, phase: "reserved", kind: "compact", owner: operation.owner };
  const registered = evidence.turns.filter(turn => turn.phase === "announced").sort((left, right) => left.registration - right.registration)[0];
  if (registered) {
    return { ...evidence, phase: "started", source: "registration", turnId: registered.turnId, registration: registered.registration };
  }
  return { ...evidence, phase: "idle" };
}

function updateTurn(
  state: CodexThreadActivity,
  turnId: string,
  update: (turn: CodexTurnOwnership) => CodexTurnOwnership,
): CodexThreadActivity {
  const previous = state.turns.find(turn => turn.turnId === turnId);
  const next = update(previous ?? { phase: "prepared", turnId });
  // A preparation record exists only while it carries correlation evidence.
  const retained = next.phase !== "prepared" || next.collaboration !== undefined || next.review !== undefined;
  const turns = previous
    ? state.turns.flatMap(turn => turn === previous ? retained ? [next] : [] : [turn])
    : retained ? [...state.turns, next] : state.turns;
  return classify({ ...state, turns });
}

/** Commit this result before running effects, like transitionQueueNotice. */
export function transition(
  state: CodexThreadActivity,
  event: CodexThreadActivityEvent,
): CodexThreadActivity {
  switch (event.type) {
    case "reserve":
      return state.reservation ? state : classify({ ...state, reservation: event.reservation });
    case "release":
      return state.reservation?.owner === event.owner ? classify({ ...state, reservation: undefined }) : state;
    case "announced":
      if (event.delivery && !state.deliveries.some(delivery => delivery.owner === event.delivery && delivery.phase === "pending")) return state;
      return updateTurn(state, event.turnId, turn => turn.phase === "announced" ? turn
        : { ...turn, phase: "announced", registration: event.order });
    case "startDelivery":
      if (state.deliveries.some(delivery => delivery.owner === event.owner)) return state;
      return classify({ ...state, deliveries: [...state.deliveries, { owner: event.owner, turnId: event.turnId, phase: "pending" }] });
    case "finishDelivery":
      return classify({ ...state, deliveries: state.deliveries.filter(delivery => delivery.owner !== event.owner) });
    case "terminalDelivery":
      return classify({ ...state, deliveries: state.deliveries.map(delivery => delivery.turnId === event.turnId ? { ...delivery, phase: "terminal" } : delivery) });
    case "unregistered":
      return updateTurn(classify({ ...state, deliveries: state.deliveries.map(delivery => delivery.turnId === event.turnId ? { ...delivery, phase: "terminal" } : delivery) }), event.turnId, turn => turn.phase !== "announced" ? turn
        : turn.execution
          ? { ...turn, phase: "terminating", registration: undefined, execution: turn.execution, collaboration: undefined }
          : { ...turn, phase: "prepared", registration: undefined, execution: undefined, collaboration: undefined });
    case "executionAccepted":
    case "executionResolved":
      return updateTurn(state, event.turnId, turn => {
        // A terminal event can retire this registration while mode lookup is
        // awaited. A repeated start with the same ID is a different receipt.
        if (event.type === "executionResolved"
          && (turn.phase !== "announced" || turn.registration !== event.registration || turn.execution)) return turn;
        const execution = { mode: event.mode, order: turn.execution?.order ?? event.order };
        return turn.phase === "announced" ? { ...turn, execution }
          : { ...turn, phase: "accepted", execution };
      });
    case "executionChanged":
      return updateTurn(state, event.turnId, turn => turn.execution
        ? { ...turn, execution: { ...turn.execution, mode: event.mode } } : turn);
    case "executionForgotten":
      return updateTurn(state, event.turnId, turn => turn.phase === "announced"
        ? { ...turn, execution: undefined }
        : { ...turn, phase: "prepared", registration: undefined, execution: undefined });
    case "collaboration":
      return updateTurn(state, event.turnId, turn => ({ ...turn, collaboration: event.mode }));
    case "review":
      return updateTurn(state, event.turnId, turn => ({ ...turn, review: event.active
        ? { phase: "active", order: turn.review?.phase === "active" ? turn.review.order : event.order,
          interruptTurnId: turn.review?.interruptTurnId, interruptOrder: turn.review?.interruptOrder }
        : turn.review?.interruptTurnId ? { phase: "correlating", interruptTurnId: turn.review.interruptTurnId, interruptOrder: turn.review.interruptOrder! } : undefined }));
    case "reviewInterrupt":
      return updateTurn(state, event.turnId, turn => ({ ...turn, review: turn.review?.phase === "active"
        ? { ...turn.review, interruptTurnId: event.interruptTurnId,
          interruptOrder: event.interruptTurnId ? turn.review.interruptOrder ?? event.order : undefined }
        : event.interruptTurnId ? { phase: "correlating", interruptTurnId: event.interruptTurnId, interruptOrder: turn.review?.interruptOrder ?? event.order } : undefined }));
    case "retry": {
      const operations = state.operations.flatMap(operation => operation.lifetime === "active" ? []
        : [{ ...operation, lifetime: "settled-retained" as const }]);
      return classify({ ...state, operations: event.operation
        ? [...operations.filter(operation => operation.owner !== event.operation), { ...event.operation, owner: event.operation, lifetime: "active-retained" }]
        : operations });
    }
    case "retryUpdated":
      return classify({ ...state, operations: state.operations.map(operation => operation.owner === event.owner ? { ...operation, ...event.patch } : operation) });
    case "retryReleased":
      return classify({ ...state, operations: state.operations.flatMap(operation => operation.owner !== event.owner ? [operation]
        : operation.lifetime === "settled-retained" ? [] : [{ ...operation, lifetime: "active" as const }]) });
    case "observe":
      return event.observation.sequence < state.statusWatermark ? state : classify({ ...state,
        statusWatermark: event.observation.sequence, observation: event.observation,
        providerStatus: event.observation.status,
        providerOrder: event.observation.status === "active" ? state.providerOrder ?? event.order : undefined,
      });
    case "seed":
      return event.status ? classify({ ...state, providerStatus: event.status,
        providerOrder: event.status === "active" ? state.providerOrder ?? event.order : undefined,
      }) : state;
    case "acknowledgeObservation":
      return state.observation === event.observation ? classify({ ...state, observation: undefined }) : state;
    case "restoreObservation":
      return state.observation?.sequence !== event.sequence ? state : classify({ ...state,
        observation: event.previous, providerStatus: event.previous?.status,
        providerOrder: event.previous?.status === "active" ? state.providerOrder ?? event.order : undefined,
      });
    case "originAdded":
      return state.origins.some(origin => origin.owner === event.origin) ? state
        : classify({ ...state, origins: [...state.origins, { owner: event.origin, value: { ...event.origin }, order: event.order }] });
    case "originRemoved":
      return classify({ ...state, origins: state.origins.filter(origin => origin.owner !== event.origin) });
    case "originBound":
      return classify({ ...state, origins: state.origins.map(origin => origin.owner === event.origin
        ? { ...origin, value: { ...origin.value, threadId: event.turn.threadId, turnId: event.turn.turnId } } : origin) });
    case "reviewAdmission": {
      const previous = state.admissions.find(admission => admission.pendingReviewId === event.admission.pendingReviewId);
      // Claims are synchronous, before effects. Final outcomes and cancelled
      // requests cannot be claimed again by a repeated invoking terminal.
      const allowed = !previous ? event.admission.status === "scheduled"
        : previous.status === "scheduled" ? ["scheduled", "starting", "cancelled"].includes(event.admission.status)
          : previous.status === "starting" && ["started", "failed"].includes(event.admission.status);
      if (!allowed) return state;
      return classify({ ...state, admissions: previous
        ? state.admissions.map(admission => admission === previous ? event.admission : admission)
        : [...state.admissions, event.admission] });
    }
    case "reviewStartOpened":
      return state.reviewStarts.some(start => start.owner === event.owner) ? state
        : classify({ ...state, reviewStarts: [...state.reviewStarts, { owner: event.owner, terminals: [] }] });
    case "reviewStartClosed":
      return classify({ ...state, reviewStarts: state.reviewStarts.filter(start => start.owner !== event.owner) });
    case "reviewTerminal":
      return state.reviewStarts.length === 0 ? state : classify({ ...state, reviewStarts: state.reviewStarts.map(start => {
        const matches = (terminal: ReviewTerminal) => terminal.backend === event.terminal.backend
          && terminal.threadId === event.terminal.threadId && terminal.turnId === event.terminal.turnId;
        return { ...start, terminals: start.terminals.some(matches)
          ? start.terminals.map(terminal => matches(terminal) ? event.terminal : terminal)
          : [...start.terminals, event.terminal] };
      }) });
    case "reviewActivated": {
      const previous = state.liveReviews.find(({ record }) => record.backend === event.record.backend
        && record.reviewThreadId === event.record.reviewThreadId && record.turnId === event.record.turnId);
      return classify({ ...state, liveReviews: previous
        ? state.liveReviews.map(review => review === previous ? { order: previous.order, record: event.record } : review)
        : [...state.liveReviews, { order: event.order, record: event.record }] });
    }
    case "reviewFinished":
      return classify({ ...state, liveReviews: state.liveReviews.filter(({ record }) => record.backend !== event.record.backend
        || record.reviewThreadId !== event.record.reviewThreadId || record.turnId !== event.record.turnId) });
    case "reviewChildLinked":
      return classify({ ...state, reviewChildren: [...state.reviewChildren.filter(link => link.key !== event.link.key), event.link] });
    case "reviewChildUnlinked":
      return classify({ ...state, reviewChildren: state.reviewChildren.filter(link => link.key !== event.key) });
  }
}

/** Compatibility projection: registration alone did not own busy admission. */
export function codexThreadHasActiveTurn(state: CodexThreadActivity, ignoreStartReservation = false): boolean {
  switch (state.phase) {
    case "idle": return false;
    case "reserved": return activeCodexOperation(state)?.kind === "compact" || !ignoreStartReservation;
    case "started": return state.source !== "registration" || (!ignoreStartReservation && Boolean(state.reservation));
    case "terminating": return true;
  }
}
