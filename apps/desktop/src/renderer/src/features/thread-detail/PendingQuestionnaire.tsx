import {
  answerQuestionnaireOption,
  answerQuestionnaireText,
  canAdvanceQuestionnaire,
  canSubmitQuestionnaire,
  goToNextQuestion,
  goToPreviousQuestion,
  type PendingQuestionnaireState,
} from "./questionnaire";

type PendingQuestionnaireProps = {
  busy?: boolean;
  state: PendingQuestionnaireState;
  onChange: (state: PendingQuestionnaireState) => void;
  onSubmit: (state: PendingQuestionnaireState) => Promise<void> | void;
};

export function PendingQuestionnaire(props: PendingQuestionnaireProps) {
  const question = props.state.questions[props.state.currentIndex];
  const answer = props.state.answers[props.state.currentIndex];
  if (!question) {
    return null;
  }

  const isLastQuestion = props.state.currentIndex === props.state.questions.length - 1;
  const canMoveNext = canAdvanceQuestionnaire(props.state);
  const canSubmit = canSubmitQuestionnaire(props.state);
  const textAnswer = answer?.kind === "text" ? answer.value : "";

  return (
    <div className="transcript-questionnaire" role="group" aria-label="Pending input">
      <div className="transcript-questionnaire__header">
        <span className="chip chip--mode">
          Input needed
        </span>
        <span className="transcript-message__time">
          Question {props.state.currentIndex + 1} of {props.state.questions.length}
        </span>
      </div>

      <div className="transcript-questionnaire__prompt">
        {question.header ? <p className="eyebrow">{question.header}</p> : null}
        <h3>{question.question}</h3>
      </div>

      {question.options.length > 0 ? (
        <div className="transcript-questionnaire__options">
          {question.options.map((option) => {
            const selected =
              answer?.kind === "option" && answer.optionKey === option.key;
            return (
              <button
                key={option.key}
                className={`transcript-questionnaire__option${
                  selected ? " is-selected" : ""
                }`}
                type="button"
                aria-pressed={selected}
                disabled={props.busy}
                onClick={() => {
                  props.onChange(answerQuestionnaireOption(props.state, option.key));
                }}
              >
                <span className="transcript-questionnaire__option-label">
                  <span className="transcript-questionnaire__option-key">
                    {option.key}
                  </span>
                  <span>{option.label}</span>
                  {option.recommended ? (
                    <span className="transcript-questionnaire__recommended">
                      Recommended
                    </span>
                  ) : null}
                </span>
                {option.description ? (
                  <span className="transcript-questionnaire__option-description">
                    {option.description}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      {question.allowFreeform ? (
        <label className="transcript-questionnaire__freeform">
          <span>Other answer</span>
          <textarea
            value={textAnswer}
            disabled={props.busy}
            rows={3}
            onChange={(event) => {
              props.onChange(answerQuestionnaireText(props.state, event.target.value));
            }}
          />
        </label>
      ) : null}

      <div className="transcript-questionnaire__actions">
        <button
          className="button button--ghost"
          disabled={props.busy || props.state.currentIndex === 0}
          type="button"
          onClick={() => {
            props.onChange(goToPreviousQuestion(props.state));
          }}
        >
          Back
        </button>
        {isLastQuestion ? (
          <button
            className="button button--primary"
            disabled={props.busy || !canSubmit}
            type="button"
            onClick={() => {
              void props.onSubmit(props.state);
            }}
          >
            Submit
          </button>
        ) : (
          <button
            className="button button--primary"
            disabled={props.busy || !canMoveNext}
            type="button"
            onClick={() => {
              props.onChange(goToNextQuestion(props.state));
            }}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
