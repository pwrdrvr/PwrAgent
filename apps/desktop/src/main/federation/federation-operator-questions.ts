import type { FederationCapability } from "@pwragent/shared";
import { localOperatorQuestionOperations } from "../operator-requests/operator-request-runtime";
import type { FederationRouter } from "./federation-router";

type Operations = typeof localOperatorQuestionOperations;
export type OperatorQuestionOperation = keyof Operations;
export type OperatorQuestionOperationRequest<K extends OperatorQuestionOperation> = Parameters<Operations[K]>[0];
export type OperatorQuestionOperationResponse<K extends OperatorQuestionOperation> = Awaited<ReturnType<Operations[K]>>;

export const FEDERATION_OPERATOR_QUESTION_METHODS = {
  reply: "operatorRequests.reply",
  list: "operatorRequests.list",
  listPending: "operatorRequests.listPending",
  markSeen: "operatorRequests.markSeen",
  listDismissed: "operatorQuestions.listDismissed",
  dismiss: "operatorQuestions.dismiss",
} as const;

export const FEDERATION_OPERATOR_QUESTION_CAPABILITIES: Record<string, FederationCapability> = {
  [FEDERATION_OPERATOR_QUESTION_METHODS.reply]: "turn_control",
  [FEDERATION_OPERATOR_QUESTION_METHODS.list]: "thread_detail",
  [FEDERATION_OPERATOR_QUESTION_METHODS.listPending]: "pending_request_control",
  [FEDERATION_OPERATOR_QUESTION_METHODS.markSeen]: "thread_detail",
  [FEDERATION_OPERATOR_QUESTION_METHODS.listDismissed]: "thread_detail",
  [FEDERATION_OPERATOR_QUESTION_METHODS.dismiss]: "turn_control",
};

export function registerFederationOperatorQuestionHandlers(router: FederationRouter): void {
  for (const operation of Object.keys(FEDERATION_OPERATOR_QUESTION_METHODS) as OperatorQuestionOperation[]) {
    router.registerHandler(FEDERATION_OPERATOR_QUESTION_METHODS[operation], (envelope) => {
      const result = (localOperatorQuestionOperations[operation] as (request: unknown) => unknown)(envelope.params ?? {});
      return result ?? null;
    });
  }
}
