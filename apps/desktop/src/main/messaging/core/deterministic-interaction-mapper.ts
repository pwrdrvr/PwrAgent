import type {
  MessagingApprovalIntent,
  MessagingQuestionnaireIntent,
  MessagingSurfaceAction,
  MessagingSurfaceIntent,
} from "@pwragnt/shared";
import type {
  MessagingInteractionMapper,
  MessagingInteractionMapperResult,
} from "./interaction-mapper.js";

const YES_SYNONYMS = new Set([
  "yes",
  "y",
  "yeah",
  "yep",
  "allow",
  "approve",
  "approve once",
  "allow once",
  "ok",
  "okay",
]);
const NO_SYNONYMS = new Set(["no", "n", "deny", "decline", "reject"]);
const CANCEL_SYNONYMS = new Set(["cancel", "stop", "nevermind", "never mind"]);
const NEXT_SYNONYMS = new Set(["next", "forward", "continue"]);
const BACK_SYNONYMS = new Set(["back", "previous", "prev"]);
const SUBMIT_SYNONYMS = new Set(["submit", "done", "finish"]);

export class DeterministicInteractionMapper implements MessagingInteractionMapper {
  mapText(params: {
    intent: MessagingSurfaceIntent;
    text: string;
  }): MessagingInteractionMapperResult {
    const text = params.text.trim();
    const normalized = normalizeText(text);
    if (!normalized) {
      return {
        kind: "ambiguous",
        text,
      };
    }

    const actions = actionsForIntent(params.intent);
    const exactMatch = actions.find((action) =>
      actionTokens(action).some((token) => token === normalized),
    );
    if (exactMatch) {
      return {
        kind: "matched",
        action: exactMatch,
      };
    }

    const synonymMatch = matchSynonym(params.intent, normalized, actions);
    if (synonymMatch) {
      return {
        kind: "matched",
        action: synonymMatch,
      };
    }

    if (looksLikeNewInstruction(text)) {
      return {
        kind: "pass_through",
        text,
      };
    }

    return {
      kind: "ambiguous",
      text,
    };
  }
}

export function actionsForIntent(intent: MessagingSurfaceIntent): MessagingSurfaceAction[] {
  switch (intent.kind) {
    case "thread_picker":
    case "project_picker":
      return intent.page.actions;
    case "single_select":
    case "multi_select":
      return intent.choices;
    case "questionnaire":
      return questionnaireActions(intent);
    case "approval":
      return intent.decisions;
    case "confirmation":
      return intent.actions;
    default:
      return [];
  }
}

function questionnaireActions(intent: MessagingQuestionnaireIntent): MessagingSurfaceAction[] {
  const question = intent.questions[intent.currentIndex];
  const actions: MessagingSurfaceAction[] = question?.options ?? [];
  if (intent.currentIndex > 0) {
    actions.push({
      id: "questionnaire:back",
      label: "Back",
      style: "navigation",
      fallbackText: "back",
    });
  }
  if (intent.currentIndex < intent.questions.length - 1) {
    actions.push({
      id: "questionnaire:next",
      label: "Next",
      style: "navigation",
      fallbackText: "next",
    });
  } else {
    actions.push({
      id: "questionnaire:submit",
      label: "Submit",
      style: "primary",
      fallbackText: "submit",
    });
  }
  return actions;
}

function matchSynonym(
  intent: MessagingSurfaceIntent,
  normalized: string,
  actions: MessagingSurfaceAction[],
): MessagingSurfaceAction | undefined {
  if (intent.kind === "approval") {
    return matchApprovalSynonym(intent, normalized);
  }

  if (NEXT_SYNONYMS.has(normalized)) {
    return actions.find((action) => normalizeText(action.label) === "next");
  }
  if (BACK_SYNONYMS.has(normalized)) {
    return actions.find((action) => normalizeText(action.label) === "back");
  }
  if (SUBMIT_SYNONYMS.has(normalized)) {
    return actions.find((action) => normalizeText(action.label) === "submit");
  }
  if (CANCEL_SYNONYMS.has(normalized)) {
    return actions.find((action) => normalizeText(action.label) === "cancel");
  }

  return undefined;
}

function matchApprovalSynonym(
  intent: MessagingApprovalIntent,
  normalized: string,
): MessagingSurfaceAction | undefined {
  if (
    normalized === "yes for this session" ||
    normalized === "approve for session" ||
    normalized === "allow for session" ||
    normalized === "approve this session"
  ) {
    return intent.decisions.find((action) => action.decision === "accept_for_session");
  }
  if (YES_SYNONYMS.has(normalized)) {
    return intent.decisions.find((action) => action.decision === "accept");
  }
  if (NO_SYNONYMS.has(normalized)) {
    return intent.decisions.find((action) => action.decision === "decline");
  }
  if (CANCEL_SYNONYMS.has(normalized)) {
    return intent.decisions.find((action) => action.decision === "cancel");
  }

  return undefined;
}

function actionTokens(action: MessagingSurfaceAction): string[] {
  return [action.id, action.label, action.fallbackText]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => {
      const normalized = normalizeText(value);
      const labelNumber = /^(\d+)\s/.exec(normalized)?.[1];
      return labelNumber ? [normalized, labelNumber] : [normalized];
    });
}

function looksLikeNewInstruction(text: string): boolean {
  return text.split(/\s+/).filter(Boolean).length >= 3;
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}
