import type {
  AppServerBackendKind,
  AppServerMcpElicitationRequestNotification,
  AppServerPendingRequestNotification,
  AppServerToolRequestUserInputNotification,
  ListOperatorRequestsResponse,
  OperatorAsyncQuestion,
} from "@pwragent/shared";
import {
  buildThreadIdentityKey,
  operatorQuestionItemKey,
  operatorServerRequestItemKey,
} from "@pwragent/shared";
import {
  createMcpElicitationState,
  type PendingMcpInteractionState,
} from "../thread-detail/mcp-elicitation";
import { approvalDisplayCommand } from "../thread-detail/approval-display-command";

/**
 * What a thread is waiting on the operator for. Every kind but `question`
 * pauses its turn until it is answered.
 */
export type OperatorWaitKind =
  | "approval"
  | "mcp-approval"
  | "mcp-input"
  | "questionnaire"
  | "question";

export type OperatorWait = {
  /** Seen-mark key. */
  key: string;
  kind: OperatorWaitKind;
  backend: AppServerBackendKind;
  threadId: string;
  /** `backend:threadId`. */
  threadKey: string;
  title: string;
  /** What follows the kind label on the row's second line. */
  detail?: string;
  createdAt: number;
  /** The server request to answer, for every kind but `question`. */
  request?: AppServerPendingRequestNotification;
  /** Parsed elicitation, for the two MCP kinds. */
  mcp?: PendingMcpInteractionState;
  question?: OperatorAsyncQuestion;
};

/** The chip and row label for each kind. */
export const OPERATOR_WAIT_LABELS: Record<OperatorWaitKind, string> = {
  approval: "Approval",
  "mcp-approval": "MCP approval",
  "mcp-input": "MCP input",
  questionnaire: "Input needed",
  question: "Question",
};

/** Lower is more urgent: what the sidebar chip names when a thread has several. */
const KIND_RANK: Record<OperatorWaitKind, number> = {
  approval: 0,
  "mcp-approval": 1,
  "mcp-input": 2,
  questionnaire: 3,
  question: 4,
};

const MAX_TITLE_LENGTH = 160;

export function isBlockingWait(wait: Pick<OperatorWait, "kind">): boolean {
  return wait.kind !== "question";
}

/** Paused turns first, then by kind, then newest first. */
export function compareOperatorWaits(left: OperatorWait, right: OperatorWait): number {
  return KIND_RANK[left.kind] - KIND_RANK[right.kind]
    || right.createdAt - left.createdAt;
}

/** The kind a thread's chip names: its most urgent wait. */
export function leadingOperatorWait(waits: readonly OperatorWait[]): OperatorWait | undefined {
  let lead: OperatorWait | undefined;
  for (const wait of waits) {
    if (!lead || compareOperatorWaits(wait, lead) < 0) lead = wait;
  }
  return lead;
}

export function buildOperatorWaits(response: ListOperatorRequestsResponse): OperatorWait[] {
  const waits: OperatorWait[] = [];
  for (const entry of response.serverRequests) {
    const wait = waitForServerRequest(entry.backend, entry.notification, entry.createdAt);
    if (wait) waits.push(wait);
  }
  for (const question of response.questions) {
    const wait = waitForQuestion(question);
    if (wait) waits.push(wait);
  }
  return waits.sort(compareOperatorWaits);
}

function waitForServerRequest(
  backend: AppServerBackendKind,
  request: AppServerPendingRequestNotification,
  createdAt: number,
): OperatorWait | undefined {
  const { threadId, requestId } = request.params;
  if (typeof threadId !== "string" || typeof requestId !== "string") return undefined;
  const base = {
    key: operatorServerRequestItemKey(backend, threadId, requestId),
    backend,
    threadId,
    threadKey: buildThreadIdentityKey(backend, threadId),
    createdAt,
    request,
  };
  if (request.method === "mcpServer/elicitation/request") {
    const mcp = createMcpElicitationState(
      request as AppServerMcpElicitationRequestNotification,
    );
    if (!mcp) {
      return { ...base, kind: "mcp-input", title: "An MCP server needs input" };
    }
    const title = firstLine(mcp.message);
    if (mcp.mode === "url") {
      return {
        ...base,
        kind: "mcp-input",
        mcp,
        title,
        detail: `opens ${urlHost(mcp.url?.url) ?? mcp.serverName}`,
      };
    }
    if (mcp.form?.empty) {
      return { ...base, kind: "mcp-approval", mcp, title, detail: mcp.serverName };
    }
    const fields = mcp.form?.fields.length ?? 0;
    return {
      ...base,
      kind: "mcp-input",
      mcp,
      title,
      detail: `${mcp.serverName} · ${fields} field${fields === 1 ? "" : "s"}`,
    };
  }
  if (request.method === "item/tool/requestUserInput") {
    const questions = Array.isArray(
      (request as AppServerToolRequestUserInputNotification).params.questions,
    )
      ? (request as AppServerToolRequestUserInputNotification).params.questions
      : [];
    const first = questions[0];
    const title = firstLine(
      (typeof first?.question === "string" && first.question)
        || (typeof first?.header === "string" && first.header)
        || "The thread has questions for you",
    );
    return {
      ...base,
      kind: "questionnaire",
      title,
      detail: `${questions.length} question${questions.length === 1 ? "" : "s"}`,
    };
  }
  return { ...base, kind: "approval", ...approvalText(request) };
}

function approvalText(
  request: AppServerPendingRequestNotification,
): { title: string; detail?: string } {
  const command = approvalDisplayCommand(request.params);
  if (command) {
    return { title: truncate(`Run ${firstLine(command)}`), detail: "command" };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { title: "Apply file changes", detail: "file changes" };
  }
  const text = [request.params.prompt, request.params.reason]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (request.method === "review/requestApproval") {
    return { title: text ? firstLine(text) : "Start the review", detail: "review" };
  }
  return { title: text ? firstLine(text) : "Continue this turn" };
}

function waitForQuestion(question: OperatorAsyncQuestion): OperatorWait | undefined {
  const first = question.questions[0];
  if (!first) return undefined;
  const count = question.questions.length;
  const options = first.options?.length ?? 0;
  return {
    key: operatorQuestionItemKey(question.backend, question.threadId, question.messageId),
    kind: "question",
    backend: question.backend,
    threadId: question.threadId,
    threadKey: buildThreadIdentityKey(question.backend, question.threadId),
    title: firstLine(first.title),
    detail: count > 1
      ? `${count} questions`
      : options > 0
        ? `${options} option${options === 1 ? "" : "s"}`
        : undefined,
    createdAt: question.createdAt,
    question,
  };
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  return truncate(line);
}

function truncate(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

function urlHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
