import { useCallback, useMemo, useState } from "react";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";
import { approvalDisplayCommand } from "../thread-detail/approval-display-command";
import { operatorWaitLabel, type OperatorWait } from "./operator-waits";

const APPROVAL_NOTICE_PREFIX = "operator-approval:";

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

export type ApprovalNoticeInput = {
  /** Most urgent first, as the owner queue sorts them. */
  waits: readonly OperatorWait[];
  /** The thread on screen, whose transcript already shows its requests. */
  selectedThreadKey?: string;
  /** Wait keys the operator hid from this window. */
  hiddenKeys: ReadonlySet<string>;
  threadTitleForKey: (threadKey: string) => string;
  onReview: (wait: OperatorWait) => void;
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
    notices.push({
      id: approvalNoticeId(wait.key),
      title: `${wait.kind === "mcp-approval" ? operatorWaitLabel(wait) : "Approval"} needed`,
      ...approvalNoticeText(wait),
      tone: "warning",
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
        title: input.threadTitleForKey(wait.threadKey),
        ...(wait.federationTarget ? { instanceId: wait.federationTarget.instanceId } : {}),
      },
      actions: [{
        label: "Review",
        tone: "primary",
        onClick: () => input.onReview(wait),
      }],
      onDismiss: () => input.onHide(wait),
    });
  }
  return notices;
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
 * Approval notices for this window. Hidden cards stay hidden for the
 * window's life; nothing is saved, so a reload shows a pending request again.
 */
export function useApprovalNotices(
  input: Omit<ApprovalNoticeInput, "hiddenKeys" | "onHide" | "onHideAll">,
): AppNoticeToastNotice[] {
  const { waits, selectedThreadKey, threadTitleForKey, onReview } = input;
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  // Each hide also drops keys for requests that are gone, so the set holds
  // only pending requests.
  const hide = useCallback((keys: readonly string[]): void => {
    setHiddenKeys((current) => {
      const pending = new Set(waits.map((wait) => wait.key));
      const next = new Set([...current, ...keys].filter((key) => pending.has(key)));
      return next.size === current.size && [...next].every((key) => current.has(key))
        ? current
        : next;
    });
  }, [waits]);
  const onHide = useCallback((wait: OperatorWait): void => hide([wait.key]), [hide]);
  const onHideAll = useCallback((): void => {
    hide(waits.filter(isApprovalNoticeWait).map((wait) => wait.key));
  }, [hide, waits]);
  return useMemo(
    () => buildApprovalNotices({
      waits, selectedThreadKey, hiddenKeys, threadTitleForKey, onReview, onHide, onHideAll,
    }),
    [waits, selectedThreadKey, hiddenKeys, threadTitleForKey, onReview, onHide, onHideAll],
  );
}
