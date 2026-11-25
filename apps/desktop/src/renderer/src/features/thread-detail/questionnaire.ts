import type {
  AppServerToolRequestUserInputNotification,
  AppServerToolRequestUserInputResponse,
} from "@pwragent/shared/contracts/normalized-app-server";

export type PendingQuestionnaireOption = {
  key: string;
  label: string;
  description: string;
  recommended: boolean;
};

export type PendingQuestionnaireQuestion = {
  id: string;
  header: string;
  question: string;
  options: PendingQuestionnaireOption[];
  allowFreeform: boolean;
  /** Any number of options may be chosen, beside an Other answer. */
  multiSelect?: boolean;
  secret: boolean;
};

export type PendingQuestionnaireAnswer =
  | {
      kind: "option";
      optionKey: string;
      value: string;
    }
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "multi";
      /** In the order the options are listed, not the order they were picked. */
      optionKeys: string[];
      text: string;
    };

export type PendingQuestionnairePhase = "answering" | "review" | "submitted";

export type PendingQuestionnaireState = {
  method: "item/tool/requestUserInput";
  requestId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  questions: PendingQuestionnaireQuestion[];
  currentIndex: number;
  phase: PendingQuestionnairePhase;
  answers: Array<PendingQuestionnaireAnswer | null>;
};

export function createQuestionnaireState(
  request: AppServerToolRequestUserInputNotification
): PendingQuestionnaireState | undefined {
  const questions = request.params.questions
    .map((question): PendingQuestionnaireQuestion | undefined => {
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      const options: PendingQuestionnaireOption[] = [];
      for (const option of rawOptions) {
        const label = trimString(option.label);
        if (!label) {
          continue;
        }

        options.push({
          key: String.fromCharCode(65 + options.length),
          label,
          description: trimString(option.description),
          recommended: /\(recommended\)/i.test(label),
        });
      }
      const allowFreeform = question.isOther === true;

      if (options.length === 0 && !allowFreeform) {
        return undefined;
      }

      const prompt = trimString(question.question);
      const header = trimString(question.header);
      const id = trimString(question.id);
      if (!id || (!prompt && !header)) {
        return undefined;
      }

      return {
        id,
        header,
        question: prompt || header,
        options,
        allowFreeform,
        multiSelect: question.multiSelect === true && options.length > 0,
        secret: question.isSecret === true,
      };
    })
    .filter((question): question is PendingQuestionnaireQuestion => Boolean(question));

  if (questions.length === 0) {
    return undefined;
  }

  return {
    method: request.method,
    requestId: request.params.requestId,
    threadId: request.params.threadId,
    ...(request.params.turnId ? { turnId: request.params.turnId } : {}),
    ...(request.params.itemId ? { itemId: request.params.itemId } : {}),
    questions,
    currentIndex: 0,
    phase: "answering",
    answers: questions.map(() => null),
  };
}

export function answerQuestionnaireOptionAndAdvance(
  state: PendingQuestionnaireState,
  optionKey: string
): PendingQuestionnaireState {
  return advanceAfterAnswer(answerQuestionnaireOption(state, optionKey));
}

export function answerQuestionnaireOption(
  state: PendingQuestionnaireState,
  optionKey: string
): PendingQuestionnaireState {
  const question = state.questions[state.currentIndex];
  const option = question?.options.find((candidate) => candidate.key === optionKey);
  if (!question || !option) {
    return state;
  }

  return answerCurrentQuestion(state, {
    kind: "option",
    optionKey: option.key,
    value: option.label,
  });
}

/** Choose or unchoose one option of a multi-select question. */
export function toggleQuestionnaireOption(
  state: PendingQuestionnaireState,
  optionKey: string
): PendingQuestionnaireState {
  const question = state.questions[state.currentIndex];
  if (!question?.multiSelect || !question.options.some((option) => option.key === optionKey)) {
    return state;
  }
  const current = state.answers[state.currentIndex];
  const chosen = new Set(current?.kind === "multi" ? current.optionKeys : []);
  if (chosen.has(optionKey)) chosen.delete(optionKey);
  else chosen.add(optionKey);
  return answerCurrentQuestion(state, {
    kind: "multi",
    optionKeys: question.options.filter((option) => chosen.has(option.key)).map((option) => option.key),
    text: current?.kind === "multi" ? current.text : "",
  });
}

export function answerQuestionnaireText(
  state: PendingQuestionnaireState,
  value: string
): PendingQuestionnaireState {
  const question = state.questions[state.currentIndex];
  if (!question?.allowFreeform) {
    return state;
  }
  if (question.multiSelect) {
    // Other text sits beside the chosen options rather than replacing them.
    const current = state.answers[state.currentIndex];
    return answerCurrentQuestion(state, {
      kind: "multi",
      optionKeys: current?.kind === "multi" ? current.optionKeys : [],
      text: value,
    });
  }

  return answerCurrentQuestion(state, {
    kind: "text",
    value,
  });
}

export function goToNextQuestion(
  state: PendingQuestionnaireState
): PendingQuestionnaireState {
  if (!canAdvanceQuestionnaire(state)) {
    return state;
  }

  return {
    ...state,
    currentIndex: Math.min(state.currentIndex + 1, state.questions.length - 1),
  };
}

export function goToPreviousQuestion(
  state: PendingQuestionnaireState
): PendingQuestionnaireState {
  if (state.phase === "review" || state.phase === "submitted") {
    return {
      ...state,
      currentIndex: Math.max(0, state.questions.length - 1),
      phase: "answering",
    };
  }

  if (state.currentIndex <= 0) {
    return state;
  }

  return {
    ...state,
    currentIndex: state.currentIndex - 1,
    phase: "answering",
  };
}

export function canAdvanceQuestionnaire(state: PendingQuestionnaireState): boolean {
  return (
    state.phase === "answering" &&
    state.currentIndex < state.questions.length - 1 &&
    isAnswerComplete(state.answers[state.currentIndex])
  );
}

export function canSubmitQuestionnaire(state: PendingQuestionnaireState): boolean {
  return state.answers.every(isAnswerComplete);
}

export function buildQuestionnaireResponse(
  state: PendingQuestionnaireState
): AppServerToolRequestUserInputResponse {
  return {
    answers: Object.fromEntries(
      state.questions.map((question, index) => [
        question.id,
        {
          answers: answerValue(state.answers[index], question),
        },
      ])
    ),
  };
}

function advanceAfterAnswer(
  state: PendingQuestionnaireState
): PendingQuestionnaireState {
  if (state.currentIndex < state.questions.length - 1) {
    return {
      ...state,
      currentIndex: state.currentIndex + 1,
      phase: "answering",
    };
  }

  return state;
}

function answerCurrentQuestion(
  state: PendingQuestionnaireState,
  answer: PendingQuestionnaireAnswer
): PendingQuestionnaireState {
  const answers = [...state.answers];
  answers[state.currentIndex] = answer;

  return {
    ...state,
    answers,
  };
}

function isAnswerComplete(
  answer: PendingQuestionnaireAnswer | null | undefined
): boolean {
  if (answer?.kind === "multi") {
    return answer.optionKeys.length > 0 || answer.text.trim().length > 0;
  }
  return Boolean(answer && answerValue(answer).length > 0);
}

function answerValue(
  answer: PendingQuestionnaireAnswer | null | undefined,
  question?: PendingQuestionnaireQuestion
): string[] {
  if (!answer) {
    return [];
  }
  if (answer.kind === "multi") {
    const labels = (question?.options ?? [])
      .filter((option) => answer.optionKeys.includes(option.key))
      .map((option) => option.label);
    const text = answer.text.trim();
    return text ? [...labels, text] : labels;
  }

  const value = answer.value.trim();
  return value ? [value] : [];
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
