import type {
  AppServerToolRequestUserInputQuestion,
  AppServerToolRequestUserInputResponse,
} from "@pwragent/shared/contracts/normalized-app-server";

/**
 * Agent questions arrive in two ACP shapes, and both are shown on the
 * questionnaire card Codex's and Claude's questions use: one question at a
 * time, with Back and Next.
 *
 * - The unstable ACP `elicitation/create` form, which Antigravity's
 *   ask_question sends: one schema property per question.
 * - Grok's `_x.ai/ask_user_question` extension request.
 *
 * The card answers with option labels and the operator's own text. Each
 * converter here maps those back to what its agent asked for. A form whose
 * fields the card cannot ask is left to the MCP elicitation card.
 */

type UserInputAnswers = AppServerToolRequestUserInputResponse["answers"];

export type AcpFormContentValue = string | string[];

export type AcpElicitationUserInput = {
  questions: AppServerToolRequestUserInputQuestion[];
  /** The form content for the card's answers, keyed by schema property. */
  content: (answers: UserInputAnswers) => Record<string, AcpFormContentValue>;
};

type ChoiceOption = { value: string; label: string; description: string };

type FormQuestion =
  | { kind: "choice"; key: string; options: ChoiceOption[]; otherKey?: string; otherIsValue: boolean }
  | { kind: "multi"; key: string; options: ChoiceOption[]; otherKey?: string }
  | { kind: "text"; key: string };

/**
 * The free-text field that answers "Other" for choice `<key>`. Antigravity
 * names it `<key>_other`; OMP's ask dialog names it `<key>__other`.
 */
const OTHER_FIELD_SUFFIXES = ["__other", "_other"] as const;

/**
 * A form is asked as questions only when every field is a single choice, a
 * multiple choice, or plain text, and choices have distinct labels so an
 * answer names exactly one option. The card needs an answer to every
 * question, so a text field of its own must be required; an optional one
 * leaves the form to the form card, where it can stay empty. Anything else
 * returns undefined.
 */
export function acpElicitationUserInput(params: Record<string, unknown>): AcpElicitationUserInput | undefined {
  const schema = asRecord(params.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (schema?.type !== "object" || !properties) return undefined;
  const entries = Object.entries(properties);
  if (entries.length === 0) return undefined;
  const required = new Set(Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === "string")
    : []);
  // Cognition's agents let a choice take text with no field of its own.
  const otherIsValue = asRecord(params._meta)?.["cognition.ai/allowOther"] === true;

  const parsed = new Map<string, FormQuestion>();
  const plain = new Map<string, Record<string, unknown>>();
  for (const [key, value] of entries) {
    const property = asRecord(value);
    if (!property) return undefined;
    if (property.type === "string" && !hasChoices(property)) {
      if (!isPlainText(property)) return undefined;
      plain.set(key, property);
      continue;
    }
    const question = choiceQuestion(key, property, otherIsValue);
    if (!question) return undefined;
    parsed.set(key, question);
  }

  // A plain text field whose name points at a choice is that choice's Other.
  // An answer fills only one of the two, so neither may be required.
  const folded = new Set<string>();
  for (const key of plain.keys()) {
    const suffix = OTHER_FIELD_SUFFIXES.find((candidate) => key.endsWith(candidate));
    const owner = suffix ? parsed.get(key.slice(0, -suffix.length)) : undefined;
    if (!owner || owner.kind === "text" || owner.otherKey) continue;
    if (required.has(owner.key) || required.has(key)) continue;
    owner.otherKey = key;
    folded.add(key);
  }
  for (const key of plain.keys()) {
    if (folded.has(key)) continue;
    if (!required.has(key)) return undefined;
    parsed.set(key, { kind: "text", key });
  }

  const message = typeof params.message === "string" ? params.message.trim() : "";
  const ordered = entries.flatMap(([key]) => {
    const question = parsed.get(key);
    return question ? [question] : [];
  });
  const questions = ordered.map((question): AppServerToolRequestUserInputQuestion => {
    const property = asRecord(properties[question.key]) ?? {};
    const title = text(property.title);
    const description = text(property.description);
    // A description is the question and the title its heading; with no
    // description the title is the question, as Antigravity sends it.
    return {
      id: question.key,
      header: description ? title ?? "" : "",
      question: description ?? title ?? (message || question.key),
      isOther: question.kind === "text" || Boolean(question.otherKey)
        || (question.kind === "choice" && question.otherIsValue),
      isSecret: false,
      options: question.kind === "text"
        ? null
        : question.options.map((option) => ({ label: option.label, description: option.description })),
      ...(question.kind === "multi" ? { multiSelect: true } : {}),
    };
  });

  return {
    questions,
    content: (answers) => {
      // Entries, not assignment: a `__proto__` key must stay an own property.
      const content: Array<[string, AcpFormContentValue]> = [];
      for (const question of ordered) {
        const values = answerStrings(ownValue(answers, question.key));
        if (values.length === 0) continue;
        if (question.kind === "text") {
          content.push([question.key, values.join("\n")]);
          continue;
        }
        const byLabel = new Map(question.options.map((option) => [option.label, option.value]));
        const chosen = values.flatMap((value) => {
          const option = byLabel.get(value);
          return option === undefined ? [] : [option];
        });
        const other = values.filter((value) => !byLabel.has(value)).join("\n");
        if (question.kind === "multi") {
          if (chosen.length > 0) content.push([question.key, chosen]);
        } else if (chosen[0] !== undefined) {
          content.push([question.key, chosen[0]]);
        } else if (other && question.otherIsValue && !question.otherKey) {
          content.push([question.key, other]);
        }
        if (other && question.otherKey) content.push([question.otherKey, other]);
      }
      return Object.fromEntries(content);
    },
  };
}

function choiceQuestion(
  key: string,
  property: Record<string, unknown>,
  otherIsValue: boolean,
): FormQuestion | undefined {
  if (property.type === "string") {
    const options = titledOptions(property.oneOf) ?? enumOptions(property.enum, property.enumNames);
    return options ? { kind: "choice", key, options, otherIsValue } : undefined;
  }
  if (property.type === "array") {
    // The card cannot hold the operator to a count, so a count is left to
    // the form card.
    const minItems = property.minItems;
    if ((minItems !== undefined && minItems !== 0) || property.maxItems !== undefined) return undefined;
    const items = asRecord(property.items);
    const options = titledOptions(items?.anyOf) ?? titledOptions(items?.oneOf) ?? enumOptions(items?.enum);
    return options ? { kind: "multi", key, options } : undefined;
  }
  return undefined;
}

function hasChoices(property: Record<string, unknown>): boolean {
  return Array.isArray(property.oneOf) || Array.isArray(property.enum);
}

/** Text the card can take as it is: no format, pattern, or length to enforce. */
function isPlainText(property: Record<string, unknown>): boolean {
  return property.format === undefined && property.pattern === undefined
    && property.minLength === undefined && property.maxLength === undefined;
}

function titledOptions(entries: unknown): ChoiceOption[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const options: ChoiceOption[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (typeof record?.const !== "string") return undefined;
    const label = text(record.title) ?? text(record.const);
    if (!label) return undefined;
    options.push({ value: record.const, label, description: text(record.description) ?? "" });
  }
  return distinctLabels(options);
}

function enumOptions(entries: unknown, names?: unknown): ChoiceOption[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const labels = Array.isArray(names) ? names : [];
  const options: ChoiceOption[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "string") return undefined;
    const label = text(labels[index]) ?? text(entry);
    if (!label) return undefined;
    options.push({ value: entry, label, description: "" });
  }
  return distinctLabels(options);
}

/** The card answers with a label, so two options with one label are one answer. */
function distinctLabels(options: ChoiceOption[]): ChoiceOption[] | undefined {
  return new Set(options.map((option) => option.label)).size === options.length ? options : undefined;
}

export type GrokAskUserQuestionResponse =
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<string, { notes: string }>;
    }
  | { outcome: "cancelled" };

export type GrokUserInput = {
  sessionId: string;
  toolCallId?: string;
  questions: AppServerToolRequestUserInputQuestion[];
  response: (answers: UserInputAnswers) => GrokAskUserQuestionResponse;
};

/**
 * Grok's `_x.ai/ask_user_question`, as Grok Build 1.0.45 sends it. Grok keys
 * each answer by the question's text and takes the operator's own text as
 * an "Other" choice with `annotations[question].notes`.
 */
export function grokAskUserQuestionInput(raw: Record<string, unknown>): GrokUserInput | undefined {
  // Some builds wrap the request as `{ method, params }`.
  const params = asRecord(raw.params) && typeof raw.method === "string" ? asRecord(raw.params)! : raw;
  const sessionId = text(params.sessionId);
  if (!sessionId || !Array.isArray(params.questions)) return undefined;
  const asked = params.questions.flatMap((value) => {
    const question = asRecord(value);
    const prompt = text(question?.question);
    if (!question || !prompt) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((entry) => {
      const option = asRecord(entry);
      const label = text(option?.label);
      return label ? [{ label, description: text(option?.description) ?? "" }] : [];
    });
    return [{ prompt, options, multiSelect: question.multiSelect === true && options.length > 0 }];
  });
  // Answers are keyed by question text, so two questions with one text
  // would share one answer.
  if (asked.length === 0 || new Set(asked.map((question) => question.prompt)).size !== asked.length) {
    return undefined;
  }
  return {
    sessionId,
    ...(text(params.toolCallId) ? { toolCallId: text(params.toolCallId) } : {}),
    questions: asked.map((question, index) => ({
      id: String(index),
      header: "",
      question: question.prompt,
      isOther: true,
      isSecret: false,
      options: question.options.length > 0 ? question.options : null,
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })),
    response: (answers) => {
      // Entries, not assignment: a `__proto__` question must stay an own key.
      const answered: Array<[string, string[]]> = [];
      const annotations: Array<[string, { notes: string }]> = [];
      asked.forEach((question, index) => {
        const values = answerStrings(ownValue(answers, String(index)));
        if (values.length === 0) return;
        const labels = new Set(question.options.map((option) => option.label));
        const chosen = values.filter((value) => labels.has(value));
        const notes = values.filter((value) => !labels.has(value));
        answered.push([question.prompt, notes.length > 0 ? [...chosen, "Other"] : chosen]);
        if (notes.length > 0) annotations.push([question.prompt, { notes: notes.join("\n") }]);
      });
      return {
        outcome: "accepted",
        answers: Object.fromEntries(answered),
        ...(annotations.length > 0 ? { annotations: Object.fromEntries(annotations) } : {}),
      };
    },
  };
}

/** The card's answer to the request, or undefined when it was dismissed. */
export function userInputAnswers(response: unknown): UserInputAnswers | undefined {
  const answers = asRecord(asRecord(response)?.answers);
  return answers as UserInputAnswers | undefined;
}

/** The record's own value at `key`, never one it inherits. */
function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function answerStrings(answer: unknown): string[] {
  const values = asRecord(answer)?.answers;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? [trimmed] : [];
  });
}

function text(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
