import type { CodexAsyncQuestion } from "../codex-async-questions";
import type {
  AppServerBackendKind,
  AppServerPendingRequestNotification,
} from "./normalized-app-server";

/**
 * Operator requests: everything a thread is waiting on the operator for,
 * across every local thread. The To-dos tab lists them beside the to-dos,
 * and the sidebar marks each waiting thread.
 *
 * Two sources. A server request (an approval, an MCP elicitation, a blocking
 * questionnaire) pauses its turn until it is answered; the registry holds
 * every one of them. An async question is an assistant message that asks
 * without pausing; the main process tracks it until a reply answers it or
 * the operator dismisses it.
 *
 * Seen marks say which items the operator has had on screen. They cover
 * to-dos too, keyed by `operatorTodoItemKey`.
 */

/** A pending server request, as the registry holds it. */
export type OperatorServerRequest = {
  backend: AppServerBackendKind;
  notification: AppServerPendingRequestNotification;
  /** When this process first saw the request, epoch ms. */
  createdAt: number;
};

/** An unanswered `request_user_input_async` message. */
export type OperatorAsyncQuestion = {
  backend: AppServerBackendKind;
  threadId: string;
  /** The assistant message's item id. */
  messageId: string;
  questions: CodexAsyncQuestion[];
  createdAt: number;
};

export type ListOperatorRequestsResponse = {
  serverRequests: OperatorServerRequest[];
  questions: OperatorAsyncQuestion[];
  /** Item keys the operator has seen. */
  seenKeys: string[];
};

export type MarkOperatorItemsSeenRequest = {
  keys: string[];
};

export type DismissOperatorQuestionRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  messageId: string;
};

/** Marker event; listeners refetch with the list call. */
export type OperatorRequestsChangedEvent = {
  reason: "requests" | "questions" | "seen";
};

export function operatorServerRequestItemKey(
  backend: AppServerBackendKind,
  threadId: string,
  requestId: string,
): string {
  return `request:${backend}:${threadId}:${requestId}`;
}

export function operatorQuestionItemKey(
  backend: AppServerBackendKind,
  threadId: string,
  messageId: string,
): string {
  return `question:${backend}:${threadId}:${messageId}`;
}

export function operatorTodoItemKey(todoId: string): string {
  return `todo:${todoId}`;
}

/** Longest item key a seen mark stores; anything longer is not one of ours. */
export const MAX_OPERATOR_ITEM_KEY_LENGTH = 1024;
