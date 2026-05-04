import { describe, expect, it } from "vitest";
import type {
  MessagingApprovalIntent,
  MessagingQuestionnaireIntent,
  MessagingSingleSelectIntent,
} from "@pwragent/shared";
import { DeterministicInteractionMapper } from "../messaging/core/deterministic-interaction-mapper";

describe("DeterministicInteractionMapper", () => {
  const mapper = new DeterministicInteractionMapper();

  it("matches numeric fallback, action ids, and labels", () => {
    const intent = {
      id: "intent-select",
      kind: "single_select",
      createdAt: 1000,
      prompt: "Choose one",
      choices: [
        {
          id: "choice-a",
          label: "1. First thread",
          fallbackText: "1",
        },
        {
          id: "choice-b",
          label: "Second thread",
          fallbackText: "2",
        },
      ],
    } satisfies MessagingSingleSelectIntent;

    expect(mapper.mapText({ intent, text: "1" })).toMatchObject({
      kind: "matched",
      action: { id: "choice-a" },
    });
    expect(mapper.mapText({ intent, text: "choice-b" })).toMatchObject({
      kind: "matched",
      action: { id: "choice-b" },
    });
    expect(mapper.mapText({ intent, text: "Second thread." })).toMatchObject({
      kind: "matched",
      action: { id: "choice-b" },
    });
  });

  it("matches approval voice-style synonyms", () => {
    const intent = {
      id: "intent-approval",
      kind: "approval",
      createdAt: 1000,
      title: "Approval",
      body: "Run command?",
      decisions: [
        {
          id: "approval:accept",
          label: "Allow",
          decision: "accept",
        },
        {
          id: "approval:accept_for_session",
          label: "Allow for session",
          decision: "accept_for_session",
        },
        {
          id: "approval:decline",
          label: "Decline",
          decision: "decline",
        },
        {
          id: "approval:cancel",
          label: "Cancel",
          decision: "cancel",
        },
      ],
    } satisfies MessagingApprovalIntent;

    expect(mapper.mapText({ intent, text: "yes for this session" })).toMatchObject({
      kind: "matched",
      action: { id: "approval:accept_for_session" },
    });
    expect(mapper.mapText({ intent, text: "approve this session" })).toMatchObject({
      kind: "matched",
      action: { id: "approval:accept_for_session" },
    });
    expect(mapper.mapText({ intent, text: "no" })).toMatchObject({
      kind: "matched",
      action: { id: "approval:decline" },
    });
    expect(mapper.mapText({ intent, text: "cancel" })).toMatchObject({
      kind: "matched",
      action: { id: "approval:cancel" },
    });
  });

  it("matches questionnaire navigation only when available", () => {
    const intent = {
      id: "intent-questionnaire",
      kind: "questionnaire",
      createdAt: 1000,
      currentIndex: 0,
      questions: [
        {
          id: "q1",
          question: "First?",
          options: [],
        },
        {
          id: "q2",
          question: "Second?",
          options: [],
        },
      ],
    } satisfies MessagingQuestionnaireIntent;

    expect(mapper.mapText({ intent, text: "next" })).toMatchObject({
      kind: "matched",
      action: { id: "questionnaire:next" },
    });
    expect(mapper.mapText({ intent, text: "back" })).toMatchObject({
      kind: "ambiguous",
    });
  });

  it("passes unrelated instructions through instead of forcing a choice", () => {
    const intent = {
      id: "intent-select",
      kind: "single_select",
      createdAt: 1000,
      prompt: "Choose one",
      choices: [
        {
          id: "choice-a",
          label: "A",
        },
      ],
    } satisfies MessagingSingleSelectIntent;

    expect(
      mapper.mapText({ intent, text: "actually make the tests pass first" }),
    ).toEqual({
      kind: "pass_through",
      text: "actually make the tests pass first",
    });
  });
});
