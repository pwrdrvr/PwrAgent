import type {
  AppServerToolRequestUserInputNotification,
  AppServerToolRequestUserInputResponse,
} from "@pwragnt/shared";

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
    };

export type PendingQuestionnaireState = {
  method: "item/tool/requestUserInput";
  requestId: string;
  threadId: string;
  runId?: string;
  turnId?: string;
  itemId?: string;
  questions: PendingQuestionnaireQuestion[];
  currentIndex: number;
  answers: Array<PendingQuestionnaireAnswer | null>;
};

export function createQuestionnaireState(
  request: AppServerToolRequestUserInputNotification
): PendingQuestionnaireState | undefined {
  const questions = request.params.questions
    .map((question) => {
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
    ...(request.params.runId ? { runId: request.params.runId } : {}),
    ...(request.params.turnId ? { turnId: request.params.turnId } : {}),
    ...(request.params.itemId ? { itemId: request.params.itemId } : {}),
    questions,
    currentIndex: 0,
    answers: questions.map(() => null),
  };
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

export function answerQuestionnaireText(
  state: PendingQuestionnaireState,
  value: string
): PendingQuestionnaireState {
  const question = state.questions[state.currentIndex];
  if (!question?.allowFreeform) {
    return state;
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
  if (state.currentIndex <= 0) {
    return state;
  }

  return {
    ...state,
    currentIndex: state.currentIndex - 1,
  };
}

export function canAdvanceQuestionnaire(state: PendingQuestionnaireState): boolean {
  return (
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
          answers: answerValue(state.answers[index]),
        },
      ])
    ),
  };
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
  return Boolean(answer && answerValue(answer).length > 0);
}

function answerValue(answer: PendingQuestionnaireAnswer | null | undefined): string[] {
  if (!answer) {
    return [];
  }

  const value = answer.value.trim();
  return value ? [value] : [];
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
