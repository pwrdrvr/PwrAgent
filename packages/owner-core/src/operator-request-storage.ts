import type {
  AppServerBackendKind,
  CodexAsyncQuestion,
  ListOperatorRequestsRequest,
  OperatorAsyncQuestion,
} from "@pwragent/shared";

export type AsyncQuestionStatus = "open" | "answered" | "dismissed";

/**
 * Owner-local operator questions and viewer seen marks. Pending server requests
 * remain owned by the live registry, never synthesized by this storage port.
 * Operations are synchronous; the host retains its existing transaction policy.
 */
export interface OperatorRequestStorage {
  /** Preserve the first record for a message, even after it is closed. */
  insertQuestion(record: {
    backend: AppServerBackendKind;
    threadId: string;
    messageId: string;
    questions: CodexAsyncQuestion[];
    now: number;
  }): boolean;
  /** Close only open questions and discard their question text. */
  resolveQuestions(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageIds: readonly string[];
    status: Exclude<AsyncQuestionStatus, "open">;
    now: number;
  }): boolean;
  dismissQuestionsForThread(params: { backend: AppServerBackendKind; threadId: string; now: number }): boolean;
  /** Repeated dismissals make no durable write. */
  dismissQuestion(params: { backend: AppServerBackendKind; threadId: string; messageId: string; now: number }): boolean;
  listOpenQuestions(): OperatorAsyncQuestion[];
  listDismissedQuestionMessageIds(params: { backend: AppServerBackendKind; threadId: string }): string[];
  listSeenKeys(): string[];
  listTodoItemKeys(filter: ListOperatorRequestsRequest): string[];
  /** Record only unseen keys in one commit; preserve their first seen time. */
  markSeen(keys: readonly string[], now: number): number;
  /** Retain open questions and seen marks for open questions, to-dos and reviews. */
  prune(now: number): void;
}
