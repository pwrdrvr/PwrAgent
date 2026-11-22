import { useState } from "react";
import type { ForgeApprovalRememberOptionId } from "@pwragent/shared/contracts/forge-agent-tools";
import type { AppServerPendingRequestNotification } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { ThreadTodoMergeMethod } from "@pwragent/shared/contracts/thread-todos";
import { buildPendingRequestResponse, type PendingRequestAction } from "@pwragent/shared/pending-request-response";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import {
  buildMcpElicitationResponse,
  type McpApprovalPersistence,
  type PendingMcpInteractionState,
} from "./mcp-elicitation";
import { buildQuestionnaireResponse, type PendingQuestionnaireState } from "./questionnaire";

type RequestResponse = Parameters<NonNullable<DesktopApi["submitServerRequest"]>>[0]["response"];

export function usePendingRequestControls({
  desktopApi,
  thread,
  pendingRequest,
  clearPendingRequest,
  updatePendingUserInput,
  updatePendingMcpInteraction,
}: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
  pendingRequest?: AppServerPendingRequestNotification;
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  updatePendingUserInput?: (
    requestId: string,
    updater: (state: PendingQuestionnaireState) => PendingQuestionnaireState,
  ) => void;
  updatePendingMcpInteraction?: (
    requestId: string,
    updater: (state: PendingMcpInteractionState) => PendingMcpInteractionState,
  ) => void;
}) {
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();

  async function submitRequest(
    requestId: string,
    turnId: string | null | undefined,
    buildResponse: () => RequestResponse,
    nextStatus?: string,
  ): Promise<void> {
    if (!desktopApi?.submitServerRequest || !thread) {
      setPendingRequestError("Desktop bridge is missing submitServerRequest().");
      return;
    }

    setPendingRequestBusy(true);
    setPendingRequestError(undefined);
    try {
      await desktopApi.submitServerRequest({
        backend: thread.source,
        federationTarget: thread.federation?.ref.target ?? readRendererFederationTarget(),
        threadId: thread.id,
        turnId: typeof turnId === "string" ? turnId : undefined,
        requestId,
        response: buildResponse(),
      });
      clearPendingRequest(requestId, nextStatus);
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  async function onRespondToPendingRequest(action: PendingRequestAction): Promise<void> {
    if (!pendingRequest) {
      return;
    }

    const continuesTurn =
      action.decision === "accept" ||
      action.decision === "accept_for_session" ||
      action.decision === "accept_with_execpolicy_amendment" ||
      action.decision === "apply_network_policy_amendment";
    await submitRequest(
      pendingRequest.params.requestId,
      pendingRequest.params.turnId,
      () => buildPendingRequestResponse(pendingRequest, action),
      continuesTurn ? "Thinking" : undefined,
    );
  }

  async function onSubmitPendingMcpInteraction(
    state: PendingMcpInteractionState,
    action: "accept" | "decline" | "cancel",
    persist?: McpApprovalPersistence,
    remember?: ForgeApprovalRememberOptionId,
    mergeMethod?: ThreadTodoMergeMethod,
    projectGrant?: boolean,
  ): Promise<void> {
    await submitRequest(
      state.requestId,
      state.turnId,
      () => buildMcpElicitationResponse(state, action, persist, remember, mergeMethod, projectGrant),
      action === "accept" ? "Thinking" : undefined,
    );
  }

  return {
    pendingRequestError,
    setPendingRequestBusy,
    setPendingRequestError,
    transcriptControls: {
      pendingRequestBusy,
      onRespondToPendingRequest,
      onSubmitPendingMcpInteraction,
      onPendingMcpInteractionChange: (state: PendingMcpInteractionState) => {
        updatePendingMcpInteraction?.(state.requestId, () => state);
      },
      onPendingUserInputChange: (state: PendingQuestionnaireState) => {
        updatePendingUserInput?.(state.requestId, () => state);
      },
      onSubmitPendingUserInput: async (state: PendingQuestionnaireState) => {
        await submitRequest(state.requestId, state.turnId, () => buildQuestionnaireResponse(state), "Thinking");
      },
    },
  };
}
