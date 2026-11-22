import { useCallback, useMemo, useState } from "react";
import type { SubmitServerRequestRequest } from "@pwragent/shared/contracts/agent";
import { operatorTodoItemKey } from "@pwragent/shared/contracts/operator-requests";
import {
  threadTodoCiDeploymentReviewRequest,
  threadTodoThreadKey,
  type ThreadTodo,
  type ThreadTodoCiApproval,
} from "@pwragent/shared/contracts/thread-todos";
import { openExternalUrl } from "../../lib/open-external-url";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { approvalDisplayCommand } from "../thread-detail/approval-display-command";
import { cleanComposerErrorMessage } from "../composer/composer-error-message";
import type { TodoSplitMenuEntry } from "../thread-todos/TodoSplitButton";
import { confirmCiApprovalText, threadTodoCiApprovals } from "../thread-todos/thread-todo-ci-approval";
import {
  APPROVAL_STILL_OPEN_MESSAGE,
  approvalChoices,
  type ApprovalChoice,
} from "./approval-choices";
import { operatorWaitLabel, type OperatorWait } from "./operator-waits";

const APPROVAL_NOTICE_PREFIX = "operator-approval:";
const NO_TODOS: readonly ThreadTodo[] = [];
const NO_IDS: ReadonlySet<string> = new Set();

/** Shown when the request leaves the thread open in its own card and To-dos. */
export const APPROVAL_NOTICE_HIDE_LABEL =
  "Hide notice. The request stays open in its thread and To-dos.";

/** The waits that get a card: approvals, which pause their turn on a yes or no. */
export function isApprovalNoticeWait(wait: Pick<OperatorWait, "kind">): boolean {
  return wait.kind === "approval" || wait.kind === "mcp-approval";
}

export function approvalNoticeId(waitKey: string): string {
  return `${APPROVAL_NOTICE_PREFIX}${waitKey}`;
}

/** An answer sent from a notice: in flight, or refused with its reason. */
export type ApprovalNoticeAnswer = { busyLabel: string; error?: string };

export type ApprovalNoticeInput = {
  /** Most urgent first, as the owner queue sorts them. */
  waits: readonly OperatorWait[];
  /** The thread on screen, whose transcript already shows its requests. */
  selectedThreadKey?: string;
  /** Wait keys the operator hid from this window. */
  hiddenKeys: ReadonlySet<string>;
  threadTitleForKey: (threadKey: string) => string;
  onReview: (wait: OperatorWait) => void;
  /**
   * Answers from the notice. Without it the notice offers Review alone, and
   * the operator answers on the thread's card.
   */
  onAnswer?: (wait: OperatorWait, choice: ApprovalChoice) => void;
  /** Answers sent from a notice, by wait key. */
  answers?: ReadonlyMap<string, ApprovalNoticeAnswer>;
  onHide: (wait: OperatorWait) => void;
  /** Hides every approval card, including the thread on screen's. */
  onHideAll: () => void;
};

/**
 * One durable notice per pending approval in a thread that is not on
 * screen. Hiding a notice only closes it: the request stays open, in its
 * thread and in To-dos, until it is answered.
 */
export function buildApprovalNotices(input: ApprovalNoticeInput): AppNoticeToastNotice[] {
  const notices: AppNoticeToastNotice[] = [];
  for (const wait of input.waits) {
    if (!isApprovalNoticeWait(wait)) continue;
    if (wait.threadKey === input.selectedThreadKey) continue;
    if (input.hiddenKeys.has(wait.key)) continue;
    const threadTitle = input.threadTitleForKey(wait.threadKey);
    const answer = input.answers?.get(wait.key);
    const sending = answer !== undefined && answer.error === undefined;
    const onAnswer = input.onAnswer;
    const entries = onAnswer && !sending ? approvalMenuEntries(wait, onAnswer) : [];
    notices.push({
      id: approvalNoticeId(wait.key),
      title: `${wait.kind === "mcp-approval" ? operatorWaitLabel(wait) : "Approval"} needed`,
      ...approvalNoticeText(wait),
      tone: "warning",
      ...(answer
        ? {
            status: answer.error === undefined
              ? { label: answer.busyLabel, state: "progress" as const }
              : { label: answer.error, state: "error" as const },
          }
        : {}),
      autoDismiss: false,
      dismissLabel: APPROVAL_NOTICE_HIDE_LABEL,
      dismissGroup: {
        key: "operator-approvals",
        label: "approval notices",
        actionLabel: "Hide all",
        onDismissAll: input.onHideAll,
      },
      threadLink: {
        backend: wait.backend,
        threadId: wait.threadId,
        title: threadTitle,
        ...(wait.threadTitle?.trim() && threadTitle === wait.threadTitle
          ? { titleOrigin: "owner" as const } : {}),
        ...(wait.federationTarget ? { instanceId: wait.federationTarget.instanceId } : {}),
      },
      // Review stays the default: the card shows the whole request. The
      // chevron answers from here for a request the notice already names.
      actions: [{
        label: "Review",
        tone: "primary",
        onClick: () => input.onReview(wait),
        ...(entries.length > 0
          ? { menu: { label: "Approval options", entries } }
          : {}),
      }],
      onDismiss: () => input.onHide(wait),
    });
  }
  return notices;
}

/** Allow answers first, then Decline and Cancel turn below a rule. */
function approvalMenuEntries(
  wait: OperatorWait,
  onAnswer: (wait: OperatorWait, choice: ApprovalChoice) => void,
): TodoSplitMenuEntry[] {
  const choices = approvalChoices(wait);
  if (!choices) return [];
  const all = [
    ...(choices.accept ? [choices.accept] : []),
    ...(choices.decline ? [choices.decline] : []),
    ...choices.alternatives,
  ];
  const item = (choice: ApprovalChoice): TodoSplitMenuEntry => ({
    kind: "item",
    id: choice.id,
    label: choice.label,
    onSelect: () => onAnswer(wait, choice),
  });
  const allows = all.filter((choice) => choice.effect === "allow").map(item);
  const stops = [
    ...all.filter((choice) => choice.effect === "decline"),
    ...all.filter((choice) => choice.effect === "cancel"),
  ].map(item);
  return allows.length > 0 && stops.length > 0
    ? [...allows, { kind: "separator", id: "approval-stops" }, ...stops]
    : [...allows, ...stops];
}

function approvalNoticeText(
  wait: OperatorWait,
): Pick<AppNoticeToastNotice, "message" | "facts"> {
  if (wait.kind === "mcp-approval") {
    return {
      message: wait.title,
      ...(wait.mcp?.serverName
        ? { facts: [{ label: "Server", value: wait.mcp.serverName }] }
        : {}),
    };
  }
  const command = wait.request ? approvalDisplayCommand(wait.request.params) : "";
  if (command) {
    return {
      message: "The agent wants to run a command.",
      facts: [{ label: "Command", value: command }],
    };
  }
  if (wait.request?.method === "item/fileChange/requestApproval") {
    const reason = wait.request.params.reason;
    return {
      message: typeof reason === "string" && reason.trim()
        ? reason.trim()
        : "The agent wants to apply file changes.",
    };
  }
  return { message: wait.title };
}

/**
 * The notice's in-app review: Approve asks first, in the notice, then sends
 * what the card shows to its owner. Absent, the notice offers GitHub alone.
 */
type CiApprovalNoticeReview = {
  confirming: boolean;
  running: boolean;
  /** A refusal before GitHub was asked; GitHub's own stays on the card. */
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
  onApprove: () => void;
};

function toCiApprovalNotice(
  key: string,
  todo: ThreadTodo,
  approval: ThreadTodoCiApproval,
  titleFor: ApprovalNoticeInput["threadTitleForKey"],
  onHide: () => void,
  onHideAll: () => void,
  review?: CiApprovalNoticeReview,
): AppNoticeToastNotice {
  const ownerTitle = todo.threadTitle?.trim();
  const github = { label: "Review on GitHub", onClick: () => openExternalUrl(approval.url) };
  const refusal = review?.error ?? todo.error;
  return {
    id: approvalNoticeId(key),
    // The one-shot watch saved a milestone. GitHub has the current gate state.
    title: "Deployment approval gate reached",
    message: review?.confirming
      ? confirmCiApprovalText(approval, todo.federationTarget !== undefined)
      : `${approval.repository} run #${approval.runId}`,
    tone: "warning",
    autoDismiss: false,
    facts: [
      { label: "Environments", value: approval.environments.join(", ") },
      ...(approval.ref ? [{ label: "Ref", value: approval.ref }] : []),
      ...(approval.attempt ? [{ label: "Attempt", value: String(approval.attempt) }] : []),
      ...(approval.headSha ? [{ label: "Commit", value: approval.headSha.slice(0, 12) }] : []),
    ],
    ...(review?.running
      ? { status: { label: "Approving…", state: "progress" as const } }
      : refusal ? { status: { label: refusal, state: "error" as const } } : {}),
    threadLink: {
      backend: todo.backend,
      threadId: todo.threadId,
      title: ownerTitle || titleFor(threadTodoThreadKey(todo)),
      ...(ownerTitle ? { titleOrigin: "owner" as const } : {}),
      ...(todo.federationTarget ? { instanceId: todo.federationTarget.instanceId } : {}),
    },
    actions: !review ? [{ ...github, tone: "primary" }]
      : review.running ? [{ ...github, tone: "secondary" }]
      : review.confirming ? [
          { label: "Cancel", tone: "secondary", onClick: review.onCancel },
          { label: "Approve", tone: "primary", onClick: review.onApprove },
        ]
      : [
          { ...github, tone: "secondary" },
          { label: "Approve", tone: "primary", onClick: review.onConfirm },
        ],
    dismissLabel: "Hide notice. The reminder stays in To-dos.",
    dismissGroup: {
      key: "operator-approvals",
      label: "approval notices",
      actionLabel: "Hide all",
      onDismissAll: onHideAll,
    },
    onDismiss: onHide,
  };
}

/**
 * Approval notices for this window. Hidden cards stay hidden for the
 * window's life; nothing is saved, so a reload shows a pending request again.
 */
export function useApprovalNotices(
  input: Omit<
    ApprovalNoticeInput,
    "hiddenKeys" | "onHide" | "onHideAll" | "onAnswer" | "answers"
  > & {
    ciApprovalTodos?: readonly ThreadTodo[];
    /**
     * Approves a card's deployment gate on its owner. Without it the
     * deployment notices offer Review on GitHub alone.
     */
    reviewCiDeployment?: (todo: ThreadTodo, approval: ThreadTodoCiApproval) => Promise<ThreadTodo | undefined>;
    /** Cards whose action is running in this window, from any surface. */
    runningTodoIds?: ReadonlySet<string>;
    /**
     * Sends an answer, then re-reads the owner queue before it resolves.
     * Without it the notices offer Review alone.
     */
    respond?: (
      wait: OperatorWait,
      response: SubmitServerRequestRequest["response"],
    ) => Promise<void>;
  },
): AppNoticeToastNotice[] {
  const {
    waits, ciApprovalTodos = NO_TODOS, selectedThreadKey, threadTitleForKey, onReview, respond,
    reviewCiDeployment, runningTodoIds = NO_IDS,
  } = input;
  const [confirmingKey, setConfirmingKey] = useState<string>();
  const [ciErrors, setCiErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const setCiError = useCallback((key: string, error: string | undefined): void => {
    setCiErrors((current) => {
      if (current.get(key) === error) return current;
      const next = new Map(current);
      if (error === undefined) next.delete(key);
      else next.set(key, error);
      return next;
    });
  }, []);
  const ciApprovals = useMemo(() => ciApprovalTodos.flatMap((todo) => threadTodoCiApprovals(todo)
      .map((approval) => ({ key: `${operatorTodoItemKey(todo.id)}:${approval.url}`, todo, approval }))), [ciApprovalTodos]);
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [answers, setAnswers] = useState<ReadonlyMap<string, ApprovalNoticeAnswer>>(
    () => new Map(),
  );
  // Each hide also drops keys for requests that are gone, so the set holds
  // only pending requests.
  const hide = useCallback((keys: readonly string[]): void => {
    setHiddenKeys((current) => {
      const pending = new Set([...waits, ...ciApprovals].map((entry) => entry.key));
      const next = new Set([...current, ...keys].filter((key) => pending.has(key)));
      return next.size === current.size && [...next].every((key) => current.has(key))
        ? current
        : next;
    });
  }, [waits, ciApprovals]);
  const onHide = useCallback((wait: OperatorWait): void => hide([wait.key]), [hide]);
  const onHideAll = useCallback((): void => {
    hide([...waits.filter(isApprovalNoticeWait), ...ciApprovals].map((entry) => entry.key));
  }, [hide, waits, ciApprovals]);
  // A sent answer keeps its notice busy until `respond` settles. Each change
  // drops keys for requests that are gone.
  const setAnswer = useCallback((key: string, answer: ApprovalNoticeAnswer): void => {
    setAnswers((current) => {
      const pending = new Set(waits.map((wait) => wait.key));
      const next = new Map([...current].filter(([entryKey]) => pending.has(entryKey)));
      next.set(key, answer);
      return next;
    });
  }, [waits]);
  const onAnswer = useMemo(() => respond
    ? (wait: OperatorWait, choice: ApprovalChoice): void => {
        setAnswer(wait.key, { busyLabel: choice.busyLabel });
        Promise.resolve()
          .then(() => respond(wait, choice.buildResponse()))
          .then(() => {
            // `respond` re-reads the queue, so a request that is gone has
            // already taken its card with it. One still listed gets its
            // answers back rather than a busy card that never clears.
            setAnswer(wait.key, {
              busyLabel: choice.busyLabel,
              error: APPROVAL_STILL_OPEN_MESSAGE,
            });
          })
          .catch((cause: unknown) => {
            // Without Electron's "Error invoking remote method …" wrapper.
            const reason = cleanComposerErrorMessage(
              cause instanceof Error ? cause.message : String(cause),
            );
            // Named as a failure, or it reads as the request's own text.
            setAnswer(wait.key, {
              busyLabel: choice.busyLabel,
              error: `Could not answer: ${reason}`,
            });
          });
      }
    : undefined, [respond, setAnswer]);
  return useMemo(
    () => [
      ...buildApprovalNotices({
        waits, selectedThreadKey, hiddenKeys, threadTitleForKey, onReview, onHide, onHideAll,
        ...(onAnswer ? { onAnswer, answers } : {}),
      }),
      ...ciApprovals.filter(({ key }) => !hiddenKeys.has(key))
        .map(({ key, todo, approval }) => toCiApprovalNotice(key, todo, approval, threadTitleForKey, () => hide([key]), onHideAll,
          reviewCiDeployment && threadTodoCiDeploymentReviewRequest(todo, approval)
            ? {
                confirming: confirmingKey === key,
                running: runningTodoIds.has(todo.id),
                ...(ciErrors.has(key) ? { error: ciErrors.get(key) } : {}),
                onConfirm: () => {
                  setCiError(key, undefined);
                  setConfirmingKey(key);
                },
                onCancel: () => setConfirmingKey(undefined),
                onApprove: () => {
                  setConfirmingKey(undefined);
                  void reviewCiDeployment(todo, approval).catch((cause: unknown) => {
                    const reason = cleanComposerErrorMessage(cause instanceof Error ? cause.message : String(cause));
                    setCiError(key, `Could not approve: ${reason}`);
                  });
                },
              }
            : undefined)),
    ],
    [
      waits, selectedThreadKey, hiddenKeys, threadTitleForKey, onReview, onHide, onHideAll,
      onAnswer, answers, ciApprovals, hide, reviewCiDeployment, confirmingKey, runningTodoIds, ciErrors, setCiError,
    ],
  );
}
