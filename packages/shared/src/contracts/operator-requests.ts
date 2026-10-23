import type { CodexAsyncQuestion } from "../codex-async-questions";
import type { FederationRemoteTarget } from "./federation";
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
  federationTarget?: FederationRemoteTarget;
  backend: AppServerBackendKind;
  notification: AppServerPendingRequestNotification;
  /** When this process first saw the request, epoch ms. */
  createdAt: number;
};

/** An unanswered `request_user_input_async` message. */
export type OperatorAsyncQuestion = {
  federationTarget?: FederationRemoteTarget;
  backend: AppServerBackendKind;
  threadId: string;
  /** The assistant message's item id. */
  messageId: string;
  questions: CodexAsyncQuestion[];
  createdAt: number;
};

export type ListOperatorRequestsResponse = {
  /** Mounted owners whose queues could not be read. */
  errors?: string[];
  serverRequests: OperatorServerRequest[];
  questions: OperatorAsyncQuestion[];
  /** Item keys the operator has seen. */
  seenKeys: string[];
};

export type ListOperatorRequestsRequest = {
  backend?: AppServerBackendKind;
  threadId?: string;
  federationTarget?: FederationRemoteTarget;
};

export type MarkOperatorItemsSeenRequest = {
  federationTarget?: FederationRemoteTarget;
  keys: string[];
};

export type OperatorQuestionThreadRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  federationTarget?: FederationRemoteTarget;
};

export type DismissOperatorQuestionRequest = OperatorQuestionThreadRequest & {
  messageId: string;
};

/** Marker event; listeners refetch with the list call. */
export type OperatorRequestsChangedEvent = {
  reason: "requests" | "questions" | "seen";
  backend?: AppServerBackendKind;
  threadId?: string;
  federationTarget?: FederationRemoteTarget;
};

export function operatorServerRequestItemKey(
  backend: AppServerBackendKind,
  threadId: string,
  requestId: string,
  target?: FederationRemoteTarget,
): string {
  return projectOperatorItemKey(`request:${backend}:${threadId}:${requestId}`, target);
}

export function operatorQuestionItemKey(
  backend: AppServerBackendKind,
  threadId: string,
  messageId: string,
  target?: FederationRemoteTarget,
): string {
  return projectOperatorItemKey(`question:${backend}:${threadId}:${messageId}`, target);
}

export function operatorTodoItemKey(todoId: string): string {
  const remote = /^remote-todo:([^:]+):(.+)$/.exec(todoId);
  return remote
    ? projectOperatorItemKey(`todo:${decodeURIComponent(remote[2]!)}`, { scope: "remote", instanceId: decodeURIComponent(remote[1]!) })
    : `todo:${todoId}`;
}

/** Longest item key a seen mark stores; anything longer is not one of ours. */
export const MAX_OPERATOR_ITEM_KEY_LENGTH = 1024;

/** Seen state lives with the item, even when owner-local ids collide. */
export function projectOperatorItemKey(key: string, target?: FederationRemoteTarget): string {
  return target ? `remote-operator:${encodeURIComponent(target.instanceId)}:${encodeURIComponent(key)}` : key;
}

export function parseRemoteOperatorItemKey(key: string): { target: FederationRemoteTarget; key: string } | undefined {
  if (!key.startsWith("remote-operator:")) return undefined;
  const match = /^remote-operator:([^:]+):(.+)$/.exec(key);
  if (!match) throw new Error("Invalid remote operator item key.");
  return { target: { scope: "remote", instanceId: decodeURIComponent(match[1]!) }, key: decodeURIComponent(match[2]!) };
}
