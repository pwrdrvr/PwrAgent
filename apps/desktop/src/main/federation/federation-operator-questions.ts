import type { FederationCapability } from "@pwragent/shared";
import { localOperatorQuestionOperations } from "../operator-requests/operator-request-runtime";
import type { FederationRouter } from "./federation-router";

type Operations = typeof localOperatorQuestionOperations;
export type OperatorQuestionOperation = keyof Operations;
export type OperatorQuestionOperationRequest<K extends OperatorQuestionOperation> = Parameters<Operations[K]>[0];
export type OperatorQuestionOperationResponse<K extends OperatorQuestionOperation> = ReturnType<Operations[K]>;

export const FEDERATION_OPERATOR_QUESTION_METHODS = {
  listDismissed: "operatorQuestions.listDismissed",
  dismiss: "operatorQuestions.dismiss",
} as const;

export const FEDERATION_OPERATOR_QUESTION_CAPABILITIES: Record<string, FederationCapability> = {
  [FEDERATION_OPERATOR_QUESTION_METHODS.listDismissed]: "thread_detail",
  [FEDERATION_OPERATOR_QUESTION_METHODS.dismiss]: "turn_control",
};

export function registerFederationOperatorQuestionHandlers(router: FederationRouter): void {
  router.registerHandler(FEDERATION_OPERATOR_QUESTION_METHODS.listDismissed, (envelope) =>
    localOperatorQuestionOperations.listDismissed(envelope.params as OperatorQuestionOperationRequest<"listDismissed">));
  router.registerHandler(FEDERATION_OPERATOR_QUESTION_METHODS.dismiss, (envelope) => {
    localOperatorQuestionOperations.dismiss(envelope.params as OperatorQuestionOperationRequest<"dismiss">);
    return null;
  });
}
