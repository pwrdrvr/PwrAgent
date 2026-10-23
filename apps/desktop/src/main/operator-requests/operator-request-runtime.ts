import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import type { DismissOperatorQuestionRequest, OperatorQuestionThreadRequest, ListOperatorRequestsRequest, MarkOperatorItemsSeenRequest, SubmitThreadReplyRequest, SubmitThreadReplyResponse } from "@pwragent/shared";
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

function queueService(request: ListOperatorRequestsRequest): OperatorRequestService {
  if (request.federationTarget !== undefined
    || (request.backend !== undefined && !isAppServerBackendKind(request.backend))
    || (request.threadId !== undefined && (typeof request.threadId !== "string" || !request.threadId))) {
    throw new Error("Invalid owner-local operator request.");
  }
  if (!service) throw new Error("Operator request service is not ready.");
  return service;
}

export const localOperatorQuestionOperations = {
  reply: async (request: SubmitThreadReplyRequest): Promise<SubmitThreadReplyResponse> => {
    localService(request);
    const submitted = await getDesktopBackendRegistry().submitThreadReply({
      backend: request.backend, threadId: request.threadId, input: request.input,
    });
    return { backend: submitted.entry.backend, threadId: submitted.entry.threadId,
      queueStatus: submitted.status, queueEntryId: submitted.entry.id };
  },
  list: (request: ListOperatorRequestsRequest) => {
    const response = queueService(request).list(request);
    return { ...response, serverRequests: [] };
  },
  listPending: (request: ListOperatorRequestsRequest) => queueService(request).list(request).serverRequests,
  markSeen: (request: MarkOperatorItemsSeenRequest): void => {
    const current = queueService(request);
    if (!Array.isArray(request.keys) || request.keys.length > 500
      || request.keys.some((key) => typeof key !== "string" || key.startsWith("remote-operator:"))) {
      throw new Error("Invalid owner-local seen items.");
    }
    current.markSeen(request.keys);
  },
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
