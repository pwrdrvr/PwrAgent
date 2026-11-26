import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { acpElicitationUserInput, grokAskUserQuestionInput } from "../acp/acp-user-input";

type Option = { const: string; title: string };
type Field =
  | { kind: "choice"; key: string; title: string; options: Option[]; other?: "_other" | "__other" }
  | { kind: "multi"; key: string; title: string; options: Option[]; other?: "_other" | "__other" }
  | { kind: "text"; key: string; title: string };

const optionsArb = fc.uniqueArray(fc.constantFrom("Red", "Green", "Blue", "Teal", "Plum"), { minLength: 1, maxLength: 4 })
  .map((labels) => labels.map((title, index): Option => ({ const: String(index + 1), title })));
const fieldArb = (key: string): fc.Arbitrary<Field> => fc.oneof(
  fc.record({ kind: fc.constant("choice" as const), key: fc.constant(key), title: fc.constant(`Ask ${key}?`), options: optionsArb,
    other: fc.option(fc.constantFrom("_other" as const, "__other" as const), { nil: undefined }) }),
  fc.record({ kind: fc.constant("multi" as const), key: fc.constant(key), title: fc.constant(`Ask ${key}?`), options: optionsArb,
    other: fc.option(fc.constantFrom("_other" as const, "__other" as const), { nil: undefined }) }),
  fc.record({ kind: fc.constant("text" as const), key: fc.constant(key), title: fc.constant(`Ask ${key}?`) }),
);
const formArb = fc.integer({ min: 1, max: 4 })
  .chain((count) => fc.tuple(...Array.from({ length: count }, (_, index) => fieldArb(`q${index + 1}`))));

function schemaFor(fields: Field[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.kind === "text") properties[field.key] = { type: "string", title: field.title };
    if (field.kind === "choice") properties[field.key] = { type: "string", title: field.title, oneOf: field.options };
    if (field.kind === "multi") {
      properties[field.key] = { type: "array", title: field.title, items: { anyOf: field.options } };
    }
    if (field.kind !== "text" && field.other) {
      properties[`${field.key}${field.other}`] = { type: "string", title: "Other", description: `Optional free-form answer to: ${field.title}` };
    }
  }
  // The card asks a text field of its own only when the form requires it.
  const required = fields.filter((field) => field.kind === "text").map((field) => field.key);
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

describe("acpElicitationUserInput", () => {
  it("asks each choice as one question and maps the answers back to the form (oracle)", () => {
    fc.assert(fc.property(
      formArb,
      fc.array(fc.tuple(fc.array(fc.nat({ max: 3 }), { maxLength: 3 }), fc.option(fc.constantFrom("Kiwi", " Mauve "), { nil: undefined })), { minLength: 4, maxLength: 4 }),
      (fields, picks) => {
        const input = acpElicitationUserInput({ sessionId: "s", mode: "form", message: "The agent has questions.", requestedSchema: schemaFor(fields) });
        expect(input).toBeDefined();
        // One question per field; an Other field is folded into its choice.
        expect(input!.questions.map((question) => question.id)).toEqual(fields.map((field) => field.key));
        input!.questions.forEach((question, index) => {
          const field = fields[index]!;
          expect(question.question).toBe(field.title);
          expect(question.isOther).toBe(field.kind === "text" || Boolean(field.other));
          expect(question.multiSelect === true).toBe(field.kind === "multi");
          expect(question.options?.map((option) => option.label) ?? null)
            .toEqual(field.kind === "text" ? null : field.options.map((option) => option.title));
        });

        // The card answers with labels and the operator's own text.
        const answers: Record<string, { answers: string[] }> = {};
        const expected: Record<string, string | string[]> = {};
        fields.forEach((field, index) => {
          const [indexes, other] = picks[index]!;
          if (field.kind === "text") {
            if (other) {
              answers[field.key] = { answers: [other] };
              expected[field.key] = other.trim();
            }
            return;
          }
          const chosen = [...new Set(indexes.filter((pick) => pick < field.options.length))]
            .map((pick) => field.options[pick]!);
          const picked = field.kind === "choice" ? chosen.slice(0, 1) : chosen;
          const custom = field.other ? other : undefined;
          // A single choice answers with an option or with Other text, never both.
          const sent = field.kind === "choice" && picked.length > 0 ? [picked[0]!.title] : [
            ...picked.map((option) => option.title),
            ...(custom ? [custom] : []),
          ];
          if (sent.length === 0) return;
          answers[field.key] = { answers: sent };
          if (field.kind === "multi" && picked.length > 0) expected[field.key] = picked.map((option) => option.const);
          if (field.kind === "choice" && picked.length > 0) expected[field.key] = picked[0]!.const;
          if (custom && !(field.kind === "choice" && picked.length > 0)) {
            expected[`${field.key}${field.other}`] = custom.trim();
          }
        });
        expect(input!.content(answers)).toEqual(expected);
      },
    ));
  });

  it("leaves a form the questionnaire cannot ask to the form card", () => {
    const unaskable = fc.constantFrom<Record<string, unknown>>(
      { type: "number", title: "Count" },
      { type: "integer", title: "Count" },
      { type: "boolean", title: "Sure?" },
      { type: "string", title: "Email", format: "email" },
      { type: "string", title: "Name", maxLength: 20 },
      { type: "array", title: "Pick", minItems: 1, items: { anyOf: [{ const: "a", title: "A" }] } },
      { type: "string", title: "Twins", oneOf: [{ const: "a", title: "Same" }, { const: "b", title: "Same" }] },
    );
    fc.assert(fc.property(unaskable, formArb, (field, fields) => {
      const schema = schemaFor(fields) as { properties: Record<string, unknown>; required?: string[] };
      schema.properties.odd = field;
      // Required, so only the field's own shape can leave it to the form card.
      schema.required = [...(schema.required ?? []), "odd"];
      expect(acpElicitationUserInput({ requestedSchema: schema })).toBeUndefined();
    }));
    expect(acpElicitationUserInput({ requestedSchema: { type: "object", properties: {} } })).toBeUndefined();
  });

  it("asks only what the operator may leave out when the form allows it (oracle)", () => {
    // Every question needs an answer, so an optional text field of its own
    // leaves the form to the form card, and a required choice or Other
    // keeps its own field rather than share one answer.
    fc.assert(fc.property(
      fc.constantFrom("_other", "__other"),
      fc.subarray(["q1", "other", "note"] as const),
      fc.boolean(),
      (suffix, requiredKeys, withNote) => {
        const otherKey = `q1${suffix}`;
        const properties: Record<string, unknown> = {
          q1: { type: "string", title: "Color?", oneOf: [{ const: "1", title: "Red" }] },
          [otherKey]: { type: "string", title: "Other" },
          ...(withNote ? { note: { type: "string", title: "Anything else?" } } : {}),
        };
        const required = requiredKeys.map((key) => key === "other" ? otherKey : key);
        const input = acpElicitationUserInput({ requestedSchema: { type: "object", properties, required } });
        const folds = !required.includes("q1") && !required.includes(otherKey);
        const askable = (folds || required.includes(otherKey)) && (!withNote || required.includes("note"));
        if (!askable) {
          expect(input).toBeUndefined();
          return;
        }
        expect(input!.questions.map((question) => question.id))
          .toEqual(["q1", ...(folds ? [] : [otherKey]), ...(withNote ? ["note"] : [])]);
        expect(input!.questions[0]!.isOther).toBe(folds);
        const answers = { q1: { answers: ["Red"] }, [otherKey]: { answers: ["Teal"] }, note: { answers: ["Thanks"] } };
        expect(input!.content(answers)).toEqual({
          q1: "1",
          ...(folds ? {} : { [otherKey]: "Teal" }),
          ...(withNote ? { note: "Thanks" } : {}),
        });
      },
    ));
  });

  it("keeps a __proto__ field as the form's own answer", () => {
    const params = JSON.parse(`{"requestedSchema": {"type": "object", "required": ["__proto__"], "properties": {
      "__proto__": {"type": "string", "title": "Odd?"},
      "q1": {"type": "string", "title": "Pick", "oneOf": [{"const": "1", "title": "Red"}]}
    }}}`) as Record<string, unknown>;
    const input = acpElicitationUserInput(params)!;
    expect(input.questions.map((question) => question.id)).toEqual(["__proto__", "q1"]);
    const answers = JSON.parse(`{"__proto__": {"answers": ["Yes"]}, "q1": {"answers": ["Red"]}}`) as Record<string, { answers: string[] }>;
    const content = input.content(answers);
    expect(Object.hasOwn(content, "__proto__")).toBe(true);
    expect(Object.entries(content)).toEqual([["__proto__", "Yes"], ["q1", "1"]]);
    // An answer the card never gave is not read from the prototype.
    expect(input.content({ q1: { answers: ["Red"] } })).toEqual({ q1: "1" });
  });

  it("asks Antigravity's captured ask_question as two questions", () => {
    const input = acpElicitationUserInput({
      sessionId: "s", toolCallId: "call_1", mode: "form", message: "The agent has 2 questions.",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Pick a color", oneOf: [{ const: "1", title: "Red" }, { const: "2", title: "Green" }] },
          q1_other: { type: "string", title: "Other", description: "Optional free-form answer to: Pick a color" },
          q2: { type: "array", title: "Pick fruits", items: { anyOf: [{ const: "1", title: "Apple" }, { const: "2", title: "Pear" }] } },
          q2_other: { type: "string", title: "Other", description: "Optional free-form answer to: Pick fruits" },
        },
      },
    })!;
    expect(input.questions).toEqual([
      { id: "q1", header: "", question: "Pick a color", isOther: true, isSecret: false,
        options: [{ label: "Red", description: "" }, { label: "Green", description: "" }] },
      { id: "q2", header: "", question: "Pick fruits", isOther: true, isSecret: false, multiSelect: true,
        options: [{ label: "Apple", description: "" }, { label: "Pear", description: "" }] },
    ]);
    expect(input.content({ q1: { answers: ["Teal"] }, q2: { answers: ["Apple", "Pear", "Kiwi"] } }))
      .toEqual({ q1_other: "Teal", q2: ["1", "2"], q2_other: "Kiwi" });
  });
});

describe("grokAskUserQuestionInput", () => {
  // Grok Build 1.0.45-pwragent.2, captured live.
  const captured = {
    sessionId: "01a213ae-9f9f-7491-8a5a-3f847bc8f5a5",
    toolCallId: "call-a01b1553-613e-48be-b800-b4769d8603a2-0",
    questions: [
      { question: "Pick a color", options: [{ label: "Red", description: "Red" }, { label: "Green", description: "Green" }], multiSelect: null },
      { question: "Pick fruits", options: [{ label: "Apple", description: "Apple" }, { label: "Pear", description: "Pear" }], multiSelect: true },
    ],
    mode: "default",
  };

  it("asks the captured request and answers in Grok's shape", () => {
    const input = grokAskUserQuestionInput(captured)!;
    expect(input.sessionId).toBe(captured.sessionId);
    expect(input.toolCallId).toBe(captured.toolCallId);
    expect(input.questions.map((question) => [question.id, question.question, question.multiSelect === true, question.isOther]))
      .toEqual([["0", "Pick a color", false, true], ["1", "Pick fruits", true, true]]);
    expect(input.response({ "0": { answers: ["Green"] }, "1": { answers: ["Apple", "Pear"] } }))
      .toEqual({ outcome: "accepted", answers: { "Pick a color": ["Green"], "Pick fruits": ["Apple", "Pear"] } });
    // The operator's own text goes as Grok's "Other" choice with notes, as Grok accepted live.
    expect(input.response({ "0": { answers: ["Teal"] }, "1": { answers: ["Apple", "Kiwi"] } })).toEqual({
      outcome: "accepted",
      answers: { "Pick a color": ["Other"], "Pick fruits": ["Apple", "Other"] },
      annotations: { "Pick a color": { notes: "Teal" }, "Pick fruits": { notes: "Kiwi" } },
    });
    expect(grokAskUserQuestionInput({ method: "_x.ai/ask_user_question", params: captured })?.questions)
      .toEqual(input.questions);
  });

  it("keys every answer by its question and keeps only labels Grok offered (oracle)", () => {
    const question = fc.record({
      question: fc.constantFrom("Color?", "Fruit?", "Size?", "Mode?"),
      options: fc.uniqueArray(fc.constantFrom("A", "B", "C"), { maxLength: 3 }).map((labels) => labels.map((label) => ({ label }))),
      multiSelect: fc.option(fc.boolean(), { nil: null }),
    });
    fc.assert(fc.property(
      fc.uniqueArray(question, { selector: (entry) => entry.question, minLength: 1, maxLength: 4 }),
      fc.array(fc.array(fc.constantFrom("A", "B", "C", "free text"), { maxLength: 3 }), { minLength: 4, maxLength: 4 }),
      (questions, replies) => {
        const input = grokAskUserQuestionInput({ sessionId: "s", toolCallId: "t", questions })!;
        const answers = Object.fromEntries(questions.map((_, index) => [String(index), { answers: replies[index]! }]));
        const response = input.response(answers);
        expect(response.outcome).toBe("accepted");
        if (response.outcome !== "accepted") return;
        questions.forEach((asked, index) => {
          const labels = new Set<string>(asked.options.map((option) => option.label));
          const chosen = replies[index]!.filter((value) => labels.has(value));
          const notes = replies[index]!.filter((value) => !labels.has(value));
          if (replies[index]!.length === 0) {
            expect(response.answers[asked.question]).toBeUndefined();
            return;
          }
          expect(response.answers[asked.question]).toEqual(notes.length > 0 ? [...chosen, "Other"] : chosen);
          expect(response.annotations?.[asked.question]?.notes).toBe(notes.length > 0 ? notes.join("\n") : undefined);
        });
      },
    ));
  });

  it("answers a __proto__ question under its own key", () => {
    const input = grokAskUserQuestionInput({ sessionId: "s", questions: [{ question: "__proto__", options: [{ label: "A" }] }] })!;
    const response = input.response({ "0": { answers: ["A", "note"] } });
    expect(response.outcome).toBe("accepted");
    if (response.outcome !== "accepted") return;
    expect(Object.entries(response.answers)).toEqual([["__proto__", ["A", "Other"]]]);
    expect(Object.entries(response.annotations ?? {})).toEqual([["__proto__", { notes: "note" }]]);
  });

  it("refuses a request it cannot answer unambiguously", () => {
    expect(grokAskUserQuestionInput({ toolCallId: "t", questions: [{ question: "Q?", options: [] }] })).toBeUndefined();
    expect(grokAskUserQuestionInput({ sessionId: "s", questions: [] })).toBeUndefined();
    expect(grokAskUserQuestionInput({
      sessionId: "s", questions: [{ question: "Same?", options: [] }, { question: "Same?", options: [] }],
    })).toBeUndefined();
  });
});
