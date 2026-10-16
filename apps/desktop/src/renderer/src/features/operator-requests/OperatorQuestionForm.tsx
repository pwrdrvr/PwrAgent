import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CodexAsyncQuestion, OperatorAsyncQuestion } from "@pwragent/shared";
import {
  asyncQuestionDraftAnswer,
  formatAsyncQuestionDraftReply,
  initialAsyncQuestionDrafts,
  type AsyncQuestionDraft,
} from "../thread-detail/async-question-drafts";
import { resizeFreeformTextarea } from "../thread-detail/PendingQuestionnaire";

export type OperatorQuestionFormProps = {
  question: OperatorAsyncQuestion;
  /** Names the form; the card's group is "Question from Codex", so this is not. */
  label: string;
  /** Resolves true once the composer has taken the reply. */
  onSubmit: (text: string) => Promise<boolean>;
  onCancel: () => void;
};

/**
 * Answers an async question from its To-dos row, in the thread on screen.
 * The same choices as the transcript card: the agent's first option is
 * preselected, typed text replaces the chosen option, and pressing the chosen
 * option again leaves that question out. The reply is the card's, item ids
 * and all, so the transcript, the card and the tracker read it alike.
 */
export function OperatorQuestionForm(props: OperatorQuestionFormProps) {
  const { question } = props;
  const [drafts, setDrafts] = useState<AsyncQuestionDraft[]>(() =>
    initialAsyncQuestionDrafts(question.questions));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const formRef = useRef<HTMLDivElement | null>(null);
  const several = question.questions.length > 1;

  // Focus enters on the first control: an option, or the text box.
  useEffect(() => {
    formRef.current?.querySelector<HTMLElement>("button, textarea")?.focus();
  }, []);

  const readyIndexes = question.questions.flatMap((_, index) =>
    asyncQuestionDraftAnswer(drafts[index]) ? [index] : []);

  const updateDraft = (index: number, update: Partial<AsyncQuestionDraft>): void => {
    setDrafts((current) =>
      current.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...update } : draft)));
  };

  const submit = async (): Promise<void> => {
    if (sending) return;
    const text = formatAsyncQuestionDraftReply(
      question.messageId,
      question.questions,
      drafts,
      readyIndexes,
    );
    if (!text) return;
    setSending(true);
    setError(undefined);
    let accepted = false;
    try {
      accepted = await props.onSubmit(text);
    } catch (cause) {
      console.warn("Answering the question from the To-dos panel failed.", cause);
    }
    // Accepted, the row takes over and shows the answer as sent.
    if (!accepted) {
      setSending(false);
      setError("The answer was not sent. The composer is busy or unavailable.");
    }
  };

  return (
    <div
      ref={formRef}
      className="operator-question-form"
      role="group"
      aria-label={props.label}
    >
      {question.questions.map((entry, index) => (
        <QuestionField
          key={`${question.messageId}:${index}`}
          number={several ? index + 1 : undefined}
          busy={sending}
          draft={drafts[index] ?? { text: "" }}
          question={entry}
          onDraftChange={(update) => updateDraft(index, update)}
        />
      ))}
      {error ? (
        <p className="operator-question-form__error" role="alert">{error}</p>
      ) : null}
      <div className="operator-question-form__actions">
        {several ? (
          <span className="operator-question-form__count">
            {readyIndexes.length} of {question.questions.length} answered
          </span>
        ) : null}
        <button
          type="button"
          className="thread-todos-panel__row-link thread-todos-panel__row-link--quiet"
          disabled={sending}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="thread-todos-panel__row-link"
          disabled={sending || readyIndexes.length === 0}
          onClick={() => void submit()}
        >
          {sending ? "Sending…" : "Answer"}
        </button>
      </div>
    </div>
  );
}

function QuestionField(props: {
  number?: number;
  busy: boolean;
  draft: AsyncQuestionDraft;
  question: CodexAsyncQuestion;
  onDraftChange: (update: Partial<AsyncQuestionDraft>) => void;
}) {
  const titleId = useId();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const options = props.question.options ?? [];

  useLayoutEffect(() => {
    resizeFreeformTextarea(textRef.current);
  }, [props.draft.text]);

  return (
    <div
      className="operator-question-form__question"
      role={props.number ? "group" : undefined}
      aria-labelledby={props.number ? titleId : undefined}
    >
      {props.number ? (
        <p id={titleId} className="operator-question-form__title">
          {props.number}. {props.question.title}
        </p>
      ) : null}
      {options.length > 0 ? (
        <div className="operator-question-form__options">
          {options.map((option, optionIndex) => {
            // Typed text replaces the chosen option.
            const selected = !props.draft.text.trim() && props.draft.option === option;
            return (
              <button
                key={`${optionIndex}:${option}`}
                type="button"
                className={`operator-question-form__option${selected ? " is-selected" : ""}`}
                aria-pressed={selected}
                disabled={props.busy}
                onClick={() => props.onDraftChange({
                  option: selected ? undefined : option,
                  text: "",
                })}
              >
                <span className="operator-question-form__option-key" aria-hidden="true">
                  {String.fromCharCode(65 + (optionIndex % 26))}
                </span>
                <span className="operator-question-form__option-label">{option}</span>
                {optionIndex === 0 && options.length > 1 ? (
                  <span className="operator-question-form__recommended">Recommended</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <label className="operator-question-form__freeform">
        <span>{options.length > 0 ? "Or type an answer" : "Your answer"}</span>
        <textarea
          ref={textRef}
          value={props.draft.text}
          disabled={props.busy}
          rows={1}
          onChange={(event) => {
            resizeFreeformTextarea(event.currentTarget);
            props.onDraftChange({ text: event.target.value });
          }}
        />
      </label>
    </div>
  );
}
