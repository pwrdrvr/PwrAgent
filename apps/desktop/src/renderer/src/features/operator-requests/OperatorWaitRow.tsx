import { useEffect, useRef, useState, type ComponentType } from "react";
import type { SubmitServerRequestRequest } from "@pwragent/shared";
import {
  CheckIcon,
  EditsIcon,
  HelpCircleIcon,
  JumpToIcon,
  PlanIcon,
  PlugIcon,
  ShieldIcon,
  TerminalIcon,
  type IconProps,
} from "../../icons";
import { formatTodoAge } from "../thread-todos/ThreadTodoCard";
import { TodoSplitButton, type TodoSplitMenuEntry } from "../thread-todos/TodoSplitButton";
import {
  APPROVAL_STILL_OPEN_MESSAGE,
  approvalChoices,
  type ApprovalChoice,
} from "./approval-choices";
import { OperatorQuestionForm } from "./OperatorQuestionForm";
import {
  operatorWaitLabel,
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
  /** Shows the wait's thread, on its card for a question. */
  openWait: (wait: OperatorWait) => void;
  /**
   * Sends a question's answer as the card does: through the composer in the
   * thread on screen, else through the thread owner's turn FIFO. Resolves
   * true once the reply was taken.
   */
  answerQuestion?: (text: string) => Promise<boolean>;
  /** An answer to this question was taken but has not landed yet. */
  questionSent?: boolean;
};

/**
 * One thing a thread is waiting on, in the To-dos panel. Approvals answer in
 * the row, since Decline and Allow are all they take. A form or a
 * questionnaire needs its card's inputs, so its row opens the thread instead.
 * A question's row opens its card in the transcript, in the thread on screen
 * too, and a local thread's question also takes its answer in the row.
 */
export function OperatorWaitRow(props: OperatorWaitRowProps) {
  const { wait } = props;
  const [busyLabel, setBusyLabel] = useState<string>();
  const [error, setError] = useState<string>();
  const [answering, setAnswering] = useState(false);
  const answerButtonRef = useRef<HTMLButtonElement | null>(null);
  const rowMainRef = useRef<HTMLButtonElement | null>(null);
  // Where focus goes once the form closes: Answer after Cancel, the row
  // after a send, since the form held focus and is gone.
  const restoreFocusRef = useRef<"answer" | "row" | undefined>(undefined);
  const KindIcon = waitIcon(wait);
  const question = wait.kind === "question";
  // A question's row goes to its card, so it is a control in every thread.
  const opensWait = !props.current || question;

  useEffect(() => {
    const target = restoreFocusRef.current;
    if (answering || !target) return;
    restoreFocusRef.current = undefined;
    (target === "answer" ? answerButtonRef : rowMainRef).current?.focus();
  }, [answering]);
  // Leaving the thread closes the form, or coming back would reopen it and
  // pull focus into the panel.
  const canAnswerHere = props.answerQuestion !== undefined;
  useEffect(() => {
    if (!canAnswerHere) setAnswering(false);
  }, [canAnswerHere]);
  const age = formatTodoAge(wait.createdAt);
  const sub = [wait.detail, props.threadName].filter(Boolean).join(" · ");

  const run = async (
    label: string,
    work: () => Promise<void>,
    stillOpenMessage?: string,
  ): Promise<void> => {
    setBusyLabel(label);
    setError(undefined);
    try {
      await work();
      // An answer re-reads the owner queue before it resolves, so a row
      // still here is a request the owner still lists. Give its answers back.
      if (stillOpenMessage) {
        setError(stillOpenMessage);
        setBusyLabel(undefined);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusyLabel(undefined);
    }
  };

  const main = (
    <>
      <span className="thread-todo-card__kind" aria-hidden="true">
        <KindIcon size={13} />
      </span>
      <span className="thread-todos-panel__row-title">{wait.title}</span>
      <span className="thread-todo-card__age">{age}</span>
      {question ? (
        <span className="thread-todos-panel__row-jump" aria-hidden="true">
          <JumpToIcon size={12} />
        </span>
      ) : null}
    </>
  );
  const mainLabel = props.current
    ? `Show question in thread: ${wait.title}${props.unread ? ", unread" : ""}`
    : `Open thread: ${operatorWaitLabel(wait)}, ${wait.title}${
      props.threadName ? `, in ${props.threadName}` : ""
    }${props.unread ? ", unread" : ""}`;

  return (
    <div
      className="thread-todos-panel__row thread-todos-panel__row--wait"
      data-wait-kind={wait.kind}
      data-blocking={isBlockingWait(wait) ? "true" : undefined}
      data-unread={props.unread ? "true" : undefined}
    >
      {props.unread ? <span className="thread-todos-panel__unread" aria-hidden="true" /> : null}
      {opensWait ? (
        <button
          ref={rowMainRef}
          type="button"
          className="thread-todos-panel__row-main"
          aria-label={mainLabel}
          onClick={() => props.openWait(wait)}
        >
          {main}
        </button>
      ) : (
        <div className="thread-todos-panel__row-main">{main}</div>
      )}
      <p className="thread-todos-panel__row-route">
        <span className="thread-todos-panel__wait-label">{operatorWaitLabel(wait)}</span>
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
      case "mcp-input":
      case "approval":
        return renderApprovalActions();
      case "question":
        return renderQuestion();
      default:
        return null;
    }
  }

  function renderQuestion() {
    const answerQuestion = props.answerQuestion;
    if (props.questionSent) {
      // Closes once the reply reaches the transcript, which a queued reply
      // does only after the running turn ends.
      return (
        <div className="thread-todos-panel__row-actions">
          <span className="thread-todos-panel__row-busy" role="status">
            <CheckIcon size={12} />
            Answer sent
          </span>
        </div>
      );
    }
    if (answering && answerQuestion && wait.question) {
      return (
        <OperatorQuestionForm
          question={wait.question}
          label={`Answer: ${wait.title}`}
          onCancel={() => {
            restoreFocusRef.current = "answer";
            setAnswering(false);
          }}
          onSubmit={async (text) => {
            const accepted = await answerQuestion(text);
            if (accepted) {
              restoreFocusRef.current = "row";
              setAnswering(false);
            }
            return accepted;
          }}
        />
      );
    }
    // Without a send path, as before the owner could take one, another
    // thread's question is answered on its card.
    const canAnswer = answerQuestion !== undefined || !props.current;
    return (
      <div className="thread-todos-panel__row-actions">
        <button
          type="button"
          className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
          onClick={() => void run("Dismissing…", () => props.dismissQuestion(wait))}
        >
          Dismiss
        </button>
        {canAnswer ? (
          <button
            ref={answerButtonRef}
            type="button"
            className="thread-todos-panel__row-link"
            onClick={() => {
              if (answerQuestion && wait.question) {
                setAnswering(true);
              } else {
                props.openWait(wait);
              }
            }}
          >
            Answer
          </button>
        ) : null}
      </div>
    );
  }

  function renderApprovalActions() {
    const choices = approvalChoices(wait);
    if (!choices) return null;
    const answer = (choice: ApprovalChoice): void => {
      void run(
        choice.busyLabel,
        () => props.respond(wait, choice.buildResponse()),
        APPROVAL_STILL_OPEN_MESSAGE,
      );
    };
    const declineChoice = choices.decline;
    const decline = declineChoice ? (
      <button
        type="button"
        className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
        onClick={() => answer(declineChoice)}
      >
        {declineChoice.label}
      </button>
    ) : null;
    const accept = choices.accept;
    if (!accept) {
      // The operator consents on the card, where the full address shows
      // before anything opens. A row has room only for the host.
      return (
        <div className="thread-todos-panel__row-actions">
          {decline}
          <button
            type="button"
            className="thread-todos-panel__row-link"
            onClick={() => props.openWait(wait)}
          >
            Review link
          </button>
        </div>
      );
    }
    const entries: TodoSplitMenuEntry[] = choices.alternatives.map((choice) => ({
      kind: "item",
      id: choice.id,
      label: choice.label,
      onSelect: () => answer(choice),
    }));
    return (
      <div className="thread-todos-panel__row-actions">
        {decline}
        {entries.length > 0 ? (
          <TodoSplitButton
            label={accept.label}
            menuLabel={wait.kind === "approval" ? "Approval options" : "Allow options"}
            entries={entries}
            onClick={() => answer(accept)}
          />
        ) : (
          <button
            type="button"
            className="thread-todos-panel__row-link"
            onClick={() => answer(accept)}
          >
            {accept.label}
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
