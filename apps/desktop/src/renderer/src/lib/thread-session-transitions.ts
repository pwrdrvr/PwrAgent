import type { AppServerPendingRequestNotification, AppServerThreadTurnMetadata } from "@pwragent/shared";
import type { PendingQuestionnaireState } from "../features/thread-detail/questionnaire";
import type { PendingMcpInteractionState } from "../features/thread-detail/mcp-elicitation";

export type ThreadLiveLifecycleVersion = { revision: number; turnRevision: number };
export type ThreadHydrationAttempt = {
  requestVersion: number;
  lifecycle?: ThreadLiveLifecycleVersion;
};
export type ThreadHydrationState =
  | { phase: "idle"; requestVersion: number }
  | { phase: "loading"; requestVersion: number; attempt: ThreadHydrationAttempt };

export function transitionThreadHydration(
  current: ThreadHydrationState = { phase: "idle", requestVersion: 0 },
  event:
    | { type: "begin"; lifecycle?: ThreadLiveLifecycleVersion }
    | { type: "invalidate" }
    | { type: "settle"; attempt: ThreadHydrationAttempt },
): ThreadHydrationState {
  if (event.type === "settle") {
    return current.phase === "loading" && current.attempt === event.attempt
      ? { phase: "idle", requestVersion: current.requestVersion }
      : current;
  }
  const requestVersion = current.requestVersion + 1;
  return event.type === "invalidate"
    ? { phase: "idle", requestVersion }
    : { phase: "loading", requestVersion, attempt: { requestVersion, lifecycle: event.lifecycle } };
}

export function isCurrentHydration(
  current: ThreadHydrationState | undefined,
  attempt: ThreadHydrationAttempt,
): boolean {
  // Keep the version after settle: React may apply the queued session update later.
  return current?.requestVersion === attempt.requestVersion;
}

export function hydrationLifecycleChanged(
  attempt: ThreadHydrationAttempt,
  live: ThreadLiveLifecycleVersion | undefined,
  responseActive: boolean,
  backendReportedActive: boolean | undefined,
): boolean {
  // A compatible status signal supplies no turn ID or pending interaction.
  const compatibleActiveStatus =
    (attempt.lifecycle?.turnRevision ?? 0) === (live?.turnRevision ?? 0)
    && responseActive
    && backendReportedActive === true;
  return attempt.lifecycle?.revision !== live?.revision && !compatibleActiveStatus;
}

export type ThreadActiveTurnState = {
  activeTurnId?: string;
  activeTurnStartedAt?: number;
  backendReportedActive?: boolean;
};

export function transitionHydratedActiveTurn(
  current: ThreadActiveTurnState,
  event: {
    clear: boolean;
    pendingTurnId?: string;
    adoptTurn?: AppServerThreadTurnMetadata;
    backendReportedActive?: boolean;
    hasInteraction: boolean;
  },
): ThreadActiveTurnState {
  const activeTurnId = event.pendingTurnId
    ?? (event.clear ? undefined : event.adoptTurn?.id ?? current.activeTurnId);
  const activeTurnStartedAt = event.pendingTurnId
    ? current.activeTurnId === event.pendingTurnId ? current.activeTurnStartedAt : undefined
    : event.clear ? undefined
      : event.adoptTurn
        ? event.adoptTurn.startedAt
          ?? (current.activeTurnId === event.adoptTurn.id ? current.activeTurnStartedAt : undefined)
        : current.activeTurnStartedAt;
  return {
    activeTurnId,
    activeTurnStartedAt,
    backendReportedActive: event.hasInteraction || event.backendReportedActive,
  };
}

export type ThreadPendingInteractionState = {
  pendingMcpInteraction?: PendingMcpInteractionState;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingUserInput?: PendingQuestionnaireState;
  pendingStatusText?: string;
};

export function transitionHydratedInteractions(
  current: ThreadPendingInteractionState,
  event: {
    clearThinking: boolean;
    clearInteraction: boolean;
    backendReportedActive?: boolean;
    hydrated?: ThreadPendingInteractionState;
  },
): ThreadPendingInteractionState {
  const clear = event.clearThinking || event.clearInteraction;
  return {
    pendingMcpInteraction: clear ? undefined : event.hydrated ? event.hydrated.pendingMcpInteraction : current.pendingMcpInteraction,
    pendingRequest: clear ? undefined : event.hydrated ? event.hydrated.pendingRequest : current.pendingRequest,
    pendingUserInput: clear ? undefined : event.hydrated ? event.hydrated.pendingUserInput : current.pendingUserInput,
    pendingStatusText: event.hydrated?.pendingStatusText
      ?? (event.clearThinking ? undefined
        : event.clearInteraction ? event.backendReportedActive ? "Thinking" : undefined
          : current.pendingStatusText),
  };
}
