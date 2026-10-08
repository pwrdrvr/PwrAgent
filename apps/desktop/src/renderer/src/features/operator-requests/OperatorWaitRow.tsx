import { useState, type ComponentType } from "react";
import type { PendingRequestAction, SubmitServerRequestRequest } from "@pwragent/shared";
import {
  buildPendingRequestActions,
  buildPendingRequestResponse,
} from "@pwragent/shared";
import {
  EditsIcon,
  HelpCircleIcon,
  PlanIcon,
  PlugIcon,
  ShieldIcon,
  TerminalIcon,
  type IconProps,
} from "../../icons";
import {
  buildMcpElicitationResponse,
  readMcpApprovalPersistence,
} from "../thread-detail/mcp-elicitation";
import { formatTodoAge } from "../thread-todos/ThreadTodoCard";
import { TodoSplitButton, type TodoSplitMenuEntry } from "../thread-todos/TodoSplitButton";
import {
  OPERATOR_WAIT_LABELS,
  isBlockingWait,
  type OperatorWait,
} from "./operator-waits";

export type OperatorWaitRowProps = {
  wait: OperatorWait;
  /** The wait belongs to the thread on screen. */
  current: boolean;
  unread: boolean;
  /** Named on the second line when the group heading does not. */
  threadName?: string;
  respond: (
    wait: OperatorWait,
    response: SubmitServerRequestRequest["response"],
  ) => Promise<void>;
  dismissQuestion: (wait: OperatorWait) => Promise<void>;
  openWait: (wait: OperatorWait) => void;
};

/**
 * One thing a thread is waiting on, in the To-dos panel. Approvals answer in
 * the row, since Decline and Allow are all they take. A form, a
 * questionnaire or a question needs its card's inputs, so its row opens the
 * thread instead.
 */
export function OperatorWaitRow(props: OperatorWaitRowProps) {
  const { wait } = props;
  const [busyLabel, setBusyLabel] = useState<string>();
  const [error, setError] = useState<string>();
  const KindIcon = waitIcon(wait);
  const age = formatTodoAge(wait.createdAt);
  const sub = [wait.detail, props.threadName].filter(Boolean).join(" · ");

  const run = async (label: string, work: () => Promise<void>): Promise<void> => {
    setBusyLabel(label);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusyLabel(undefined);
    }
    // On success the row leaves the list, so the busy label stays until then.
  };

  const main = (
    <>
      <span className="thread-todo-card__kind" aria-hidden="true">
        <KindIcon size={13} />
      </span>
      <span className="thread-todos-panel__row-title">{wait.title}</span>
      <span className="thread-todo-card__age">{age}</span>
    </>
  );

  return (
    <div
      className="thread-todos-panel__row thread-todos-panel__row--wait"
      data-wait-kind={wait.kind}
      data-blocking={isBlockingWait(wait) ? "true" : undefined}
      data-unread={props.unread ? "true" : undefined}
    >
      {props.unread ? <span className="thread-todos-panel__unread" aria-hidden="true" /> : null}
      {props.current ? (
        <div className="thread-todos-panel__row-main">{main}</div>
      ) : (
        <button
          type="button"
          className="thread-todos-panel__row-main"
          aria-label={`Open thread: ${OPERATOR_WAIT_LABELS[wait.kind]}, ${wait.title}${
            props.threadName ? `, in ${props.threadName}` : ""
          }${props.unread ? ", unread" : ""}`}
          onClick={() => props.openWait(wait)}
        >
          {main}
        </button>
      )}
      <p className="thread-todos-panel__row-route">
        <span className="thread-todos-panel__wait-label">{OPERATOR_WAIT_LABELS[wait.kind]}</span>
        {sub ? ` · ${sub}` : ""}
      </p>
      {error ? (
        <p className="thread-todos-panel__row-error" role="alert">{error}</p>
      ) : null}
      {busyLabel ? (
        <div className="thread-todos-panel__row-actions">
          <span className="thread-todos-panel__row-busy" role="status">
            <span className="pending-spinner pending-spinner--sm" aria-hidden="true" />
            {busyLabel}
          </span>
        </div>
      ) : (
        renderActions()
      )}
    </div>
  );

  function renderActions() {
    switch (wait.kind) {
      case "mcp-approval":
        return renderMcpApproval();
      case "approval":
        return renderApproval();
      case "question":
        return (
          <div className="thread-todos-panel__row-actions">
            <button
              type="button"
              className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
              onClick={() => void run("Dismissing…", () => props.dismissQuestion(wait))}
            >
              Dismiss
            </button>
            {props.current ? null : (
              <button
                type="button"
                className="thread-todos-panel__row-link"
                onClick={() => props.openWait(wait)}
              >
                Answer
              </button>
            )}
          </div>
        );
      default:
        return null;
    }
  }

  function renderMcpApproval() {
    const mcp = wait.mcp;
    if (!mcp) return null;
    const persistence = readMcpApprovalPersistence(mcp);
    const answer = (
      label: string,
      action: "accept" | "decline" | "cancel",
      persist?: "session" | "always",
    ): void => {
      void run(label, () => props.respond(wait, buildMcpElicitationResponse(mcp, action, persist)));
    };
    const entries: TodoSplitMenuEntry[] = [
      ...(persistence.includes("session")
        ? [{
            kind: "item" as const,
            id: "session",
            label: "Allow this conversation",
            onSelect: () => answer("Allowing…", "accept", "session"),
          }]
        : []),
      ...(persistence.includes("always")
        ? [{
            kind: "item" as const,
            id: "always",
            label: "Always allow",
            onSelect: () => answer("Allowing…", "accept", "always"),
          }]
        : []),
      {
        kind: "item",
        id: "cancel",
        label: "Cancel turn",
        onSelect: () => answer("Cancelling…", "cancel"),
      },
    ];
    return (
      <div className="thread-todos-panel__row-actions">
        <button
          type="button"
          className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
          onClick={() => answer("Declining…", "decline")}
        >
          Decline
        </button>
        <TodoSplitButton
          label="Allow"
          menuLabel="Allow options"
          entries={entries}
          onClick={() => answer("Allowing…", "accept")}
        />
      </div>
    );
  }

  function renderApproval() {
    const request = wait.request;
    if (!request) return null;
    const actions = buildPendingRequestActions(request);
    const primary = actions.find((action) => action.style === "primary")
      ?? actions.find((action) => action.decision === "accept");
    const decline = actions.find((action) => action.decision === "decline");
    if (!primary) return null;
    const answer = (action: PendingRequestAction): void => {
      const label = action.decision === "decline"
        ? "Declining…"
        : action.decision === "cancel"
          ? "Cancelling…"
          : "Approving…";
      void run(label, () => props.respond(wait, buildPendingRequestResponse(request, action)));
    };
    const entries: TodoSplitMenuEntry[] = actions
      .filter((action) => action !== primary && action !== decline)
      .map((action) => ({
        kind: "item",
        id: action.id,
        label: action.label,
        onSelect: () => answer(action),
      }));
    return (
      <div className="thread-todos-panel__row-actions">
        {decline ? (
          <button
            type="button"
            className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
            onClick={() => answer(decline)}
          >
            {decline.label}
          </button>
        ) : null}
        {entries.length > 0 ? (
          <TodoSplitButton
            label={primary.label}
            menuLabel="Approval options"
            entries={entries}
            onClick={() => answer(primary)}
          />
        ) : (
          <button
            type="button"
            className="thread-todos-panel__row-link"
            onClick={() => answer(primary)}
          >
            {primary.label}
          </button>
        )}
      </div>
    );
  }
}

function waitIcon(wait: OperatorWait): ComponentType<IconProps> {
  switch (wait.kind) {
    case "approval":
      return wait.request?.method === "item/fileChange/requestApproval" ? EditsIcon : TerminalIcon;
    case "mcp-approval":
      return ShieldIcon;
    case "mcp-input":
      return PlugIcon;
    case "questionnaire":
      return PlanIcon;
    case "question":
      return HelpCircleIcon;
  }
}
