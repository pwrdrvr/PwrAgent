import type { DismissOperatorQuestionRequest, OperatorQuestionThreadRequest } from "@pwragent/shared";
import { isAppServerBackendKind } from "@pwragent/shared";
import type { OperatorRequestService } from "./operator-request-service";

let service: OperatorRequestService | undefined;

export function installOperatorRequestService(current: OperatorRequestService): void {
  service = current;
}

function localService(request: OperatorQuestionThreadRequest): OperatorRequestService {
  if (!isAppServerBackendKind(request?.backend)
    || typeof request.threadId !== "string" || !request.threadId
    || request.federationTarget !== undefined) {
    throw new Error("Invalid owner-local question request.");
  }
  if (!service) throw new Error("Operator request service is not ready.");
  return service;
}

export const localOperatorQuestionOperations = {
  listDismissed: (request: OperatorQuestionThreadRequest): string[] =>
    localService(request).listDismissedQuestions(request),
  dismiss: (request: DismissOperatorQuestionRequest): void => {
    const current = localService(request);
    if (typeof request.messageId !== "string" || !request.messageId) {
      throw new Error("Invalid question dismissal request.");
    }
    current.dismissQuestion(request);
  },
};
