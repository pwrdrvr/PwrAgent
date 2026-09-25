import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  codexAsyncQuestionItemId,
  formatCodexAsyncQuestionReply,
  type CodexAsyncQuestion,
} from "@pwragent/shared";
import { resizeFreeformTextarea } from "./PendingQuestionnaire";

type AsyncQuestionCardProps = {
  messageId: string;
  questions: readonly CodexAsyncQuestion[];
  /** Answers found in the transcript, by question item id or message id. */
  replies?: ReadonlyMap<string, string>;
  dismissed?: boolean;
  /** Resolves true once the composer has taken the reply. */
  onAnswer?: (text: string) => Promise<boolean>;
  onDismissedChange?: (dismissed: boolean) => void;
  renderTitle: (title: string) => ReactNode;
};

type QuestionDraft = {
  option?: string;
  text: string;
};

/**
 * Presents the questions Codex asked through `request_user_input_async`.
 * Codex keeps working while they wait, so answering is optional: the
 * operator can answer any of them, dismiss them, or ignore them. Every
 * question takes typed text, and the agent's first option is its
 * recommendation, preselected as Codex's own clients do.
 */
export function AsyncQuestionCard(props: AsyncQuestionCardProps) {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    props.questions.map((question) => ({
      option: question.options?.[0],
      text: "",
    }))
  );
  const [sentAnswers, setSentAnswers] = useState<Array<string | undefined>>([]);
  const [sending, setSending] = useState(false);

  const answers = props.questions.map((_, index) =>
    props.replies?.get(codexAsyncQuestionItemId(props.messageId, index))
    ?? props.replies?.get(props.messageId)
    ?? sentAnswers[index]
  );
  const openIndexes = props.questions.flatMap((_, index) =>
    answers[index] === undefined ? [index] : []
  );
  const draftAnswer = (index: number): string =>
    drafts[index]?.text.trim() || drafts[index]?.option || "";
  const readyIndexes = openIndexes.filter((index) => draftAnswer(index));
  const answering = Boolean(props.onAnswer) && !props.dismissed && openIndexes.length > 0;
  const status = openIndexes.length === 0
    ? props.questions.every((_, index) =>
        props.replies?.has(codexAsyncQuestionItemId(props.messageId, index))
        || props.replies?.has(props.messageId)
      )
      ? "Answered"
      : "Sent"
    : props.dismissed
      ? "Dismissed"
      : undefined;

  const updateDraft = (index: number, update: Partial<QuestionDraft>): void => {
    setDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index ? { ...draft, ...update } : draft
      )
    );
  };

  const submit = async (): Promise<void> => {
    if (!props.onAnswer || sending) {
      return;
    }
    const submitted = new Map(readyIndexes.map((index) => [index, draftAnswer(index)]));
    const text = formatCodexAsyncQuestionReply(
      [...submitted].map(([index, answer]) => ({
        questionItemId: codexAsyncQuestionItemId(props.messageId, index),
        question: props.questions[index]?.title ?? "",
        answer,
      }))
    );
    if (!text) {
      return;
    }
    setSending(true);
    try {
      if (await props.onAnswer(text)) {
        // A queued reply does not reach the transcript until the turn
        // ends, so hold the answers here until it does.
        setSentAnswers((current) =>
          props.questions.map((_, index) => submitted.get(index) ?? current[index])
        );
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="transcript-async-questions"
      role="group"
      aria-label={props.questions.length === 1 ? "Question from Codex" : "Questions from Codex"}
    >
      <div className="transcript-async-questions__header">
        <span className="chip chip--mode">
          {props.questions.length === 1 ? "Question" : "Questions"}
        </span>
        {status ? (
          <span className="transcript-async-questions__status">{status}</span>
        ) : null}
      </div>
      {props.questions.map((question, index) => (
        <AsyncQuestionItem
          key={`${props.messageId}:${index}`}
          answer={answers[index]}
          answering={answering}
          busy={sending}
          draft={drafts[index] ?? { text: "" }}
          question={question}
          renderTitle={props.renderTitle}
          onDraftChange={(update) => updateDraft(index, update)}
        />
      ))}
      {answering ? (
        <div className="transcript-questionnaire__actions">
          <button
            className="button button--primary"
            disabled={sending || readyIndexes.length === 0}
            type="button"
            onClick={() => {
              void submit();
            }}
          >
            Answer
          </button>
          {props.onDismissedChange ? (
            <button
              className="button button--ghost"
              disabled={sending}
              type="button"
              onClick={() => props.onDismissedChange?.(true)}
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}
      {props.dismissed && openIndexes.length > 0 && props.onAnswer ? (
        <div className="transcript-questionnaire__actions">
          <button
            className="button button--ghost"
            type="button"
            onClick={() => props.onDismissedChange?.(false)}
          >
            Show questions
          </button>
        </div>
      ) : null}
    </div>
  );
}

function AsyncQuestionItem(props: {
  answer?: string;
  answering: boolean;
  busy: boolean;
  draft: QuestionDraft;
  question: CodexAsyncQuestion;
  renderTitle: (title: string) => ReactNode;
  onDraftChange: (update: Partial<QuestionDraft>) => void;
}) {
  const titleId = useId();
  const freeformRef = useRef<HTMLTextAreaElement | null>(null);
  const options = props.question.options ?? [];
  const controlsVisible = props.answering && props.answer === undefined;

  useLayoutEffect(() => {
    resizeFreeformTextarea(freeformRef.current);
  }, [props.draft.text, controlsVisible]);

  return (
    <div
      className="transcript-async-questions__question"
      role="group"
      aria-labelledby={titleId}
    >
      <div id={titleId} className="transcript-message__text transcript-async-questions__title">
        {props.renderTitle(props.question.title)}
      </div>
      {props.answer !== undefined ? (
        <p className="transcript-async-questions__answer">
          <span className="transcript-async-questions__answer-label">Answer</span>
          <span>{props.answer}</span>
        </p>
      ) : controlsVisible ? (
        <>
          {options.length > 0 ? (
            <div className="transcript-questionnaire__options">
              {options.map((option, optionIndex) => {
                // Typed text replaces the chosen option.
                const selected = !props.draft.text.trim() && props.draft.option === option;
                return (
                  <button
                    key={`${optionIndex}:${option}`}
                    className={`transcript-questionnaire__option${selected ? " is-selected" : ""}`}
                    type="button"
                    aria-pressed={selected}
                    disabled={props.busy}
                    onClick={() => props.onDraftChange({ option, text: "" })}
                  >
                    <span className="transcript-questionnaire__option-label">
                      <span className="transcript-questionnaire__option-key">
                        {String.fromCharCode(65 + (optionIndex % 26))}
                      </span>
                      <span>{option}</span>
                      {optionIndex === 0 && options.length > 1 ? (
                        <span className="transcript-questionnaire__recommended">
                          Recommended
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
          <label className="transcript-questionnaire__freeform">
            <span>{options.length > 0 ? "Or type an answer" : "Your answer"}</span>
            <textarea
              ref={freeformRef}
              value={props.draft.text}
              disabled={props.busy}
              rows={1}
              onChange={(event) => {
                resizeFreeformTextarea(event.currentTarget);
                props.onDraftChange({ text: event.target.value });
              }}
            />
          </label>
        </>
      ) : options.length > 0 ? (
        <ul className="transcript-async-questions__options">
          {options.map((option, optionIndex) => (
            <li key={`${optionIndex}:${option}`}>{option}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
