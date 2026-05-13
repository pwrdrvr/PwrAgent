import { describe, expect, it, vi } from "vitest";
import type {
  MessagingApprovalIntent,
  MessagingConfirmationIntent,
  MessagingQuestionnaireIntent,
  MessagingSingleSelectIntent,
} from "@pwragent/messaging-interface";
import { DeterministicInteractionMapper } from "../messaging/core/deterministic-interaction-mapper";
import {
  ModelInteractionMapper,
  type ModelInteractionMapperClient,
  XaiModelInteractionMapperClient,
} from "../messaging/core/model-interaction-mapper";

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

describe("ModelInteractionMapper", () => {
  it("uses the model to map semantic replies that deterministic matching cannot", async () => {
    const client: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "action" as const,
        actionId: "command:status",
        confidence: 0.88,
      })),
    };
    const mapper = new ModelInteractionMapper(client);
    const intent = {
      id: "intent-help",
      kind: "confirmation",
      createdAt: 1000,
      title: "PwrAgent commands",
      body: "Choose a command.",
      actions: [
        { id: "command:resume", label: "Resume", fallbackText: "/resume" },
        { id: "command:status", label: "Status", fallbackText: "/status" },
      ],
    } satisfies MessagingConfirmationIntent;

    await expect(
      mapper.mapText({ intent, text: "show me what thread this chat controls" }),
    ).resolves.toMatchObject({
      kind: "matched",
      action: { id: "command:status" },
    });
    expect(client.classify).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "show me what thread this chat controls",
        actions: expect.arrayContaining([
          expect.objectContaining({ id: "command:status", index: 2 }),
        ]),
      }),
    );
  });

  it("lets the model pass unrelated short commands through", async () => {
    const client: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "pass_through" as const,
        confidence: 0.91,
      })),
    };
    const mapper = new ModelInteractionMapper(client);
    const intent = {
      id: "intent-help",
      kind: "confirmation",
      createdAt: 1000,
      title: "PwrAgent commands",
      body: "Choose a command.",
      actions: [
        { id: "command:resume", label: "Resume", fallbackText: "/resume" },
        { id: "command:status", label: "Status", fallbackText: "/status" },
      ],
    } satisfies MessagingConfirmationIntent;

    await expect(mapper.mapText({ intent, text: "compact" })).resolves.toEqual({
      kind: "pass_through",
      text: "compact",
    });
  });

  it("returns a model clarification when the reply is related but underspecified", async () => {
    const mapper = new ModelInteractionMapper({
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "clarify" as const,
        confidence: 0.72,
        clarification: "Do you mean Resume or Status?",
      })),
    });
    const intent = {
      id: "intent-help",
      kind: "confirmation",
      createdAt: 1000,
      title: "PwrAgent commands",
      body: "Choose a command.",
      actions: [
        { id: "command:resume", label: "Resume", fallbackText: "/resume" },
        { id: "command:status", label: "Status", fallbackText: "/status" },
      ],
    } satisfies MessagingConfirmationIntent;

    await expect(mapper.mapText({ intent, text: "the thread one" })).resolves.toEqual({
      kind: "clarification",
      text: "Do you mean Resume or Status?",
    });
  });

  it("keeps exact deterministic matches off the model path", async () => {
    const client: ModelInteractionMapperClient = {
      classify: vi.fn(),
    };
    const mapper = new ModelInteractionMapper(client);
    const intent = {
      id: "intent-help",
      kind: "confirmation",
      createdAt: 1000,
      title: "PwrAgent commands",
      body: "Choose a command.",
      actions: [
        { id: "command:resume", label: "Resume", fallbackText: "/resume" },
        { id: "command:status", label: "Status", fallbackText: "/status" },
      ],
    } satisfies MessagingConfirmationIntent;

    await expect(mapper.mapText({ intent, text: "/status" })).resolves.toMatchObject({
      kind: "matched",
      action: { id: "command:status" },
    });
    expect(client.classify).not.toHaveBeenCalled();
  });
});

describe("XaiModelInteractionMapperClient", () => {
  it("sends pending intent context through the structured helper prompt", async () => {
    const client = {
      generateObject: vi.fn(async () => ({
        object: {
          disposition: "action",
          actionId: "command:monitor",
          confidence: 0.83,
        },
      })),
    };
    const mapperClient = new XaiModelInteractionMapperClient({
      client,
      model: "grok-test-model",
      timeoutMs: 1234,
    });

    await expect(
      mapperClient.classify({
        intent: {
          kind: "confirmation",
          title: "PwrAgent commands",
          body: "Choose a command.",
        },
        actions: [
          {
            id: "command:monitor",
            label: "Monitor",
            fallbackText: "/monitor",
            index: 1,
          },
        ],
        text: "start watching this",
      }),
    ).resolves.toEqual({
      status: "ok",
      disposition: "action",
      actionId: "command:monitor",
      confidence: 0.83,
    });
    expect(client.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "grok-test-model",
        promptCacheKey: "messaging-interaction-mapper-v1",
        schemaName: "messaging_interaction_mapping",
        system: expect.stringContaining("map a dictated or typed messaging reply"),
        prompt: expect.stringContaining("start watching this"),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects model action ids that were not offered", async () => {
    const client = {
      generateObject: vi.fn(async () => ({
        object: {
          disposition: "action",
          actionId: "command:detach",
          confidence: 0.92,
        },
      })),
    };
    const mapperClient = new XaiModelInteractionMapperClient({ client });

    await expect(
      mapperClient.classify({
        intent: {
          kind: "confirmation",
          title: "PwrAgent commands",
        },
        actions: [
          {
            id: "command:monitor",
            label: "Monitor",
            index: 1,
          },
        ],
        text: "detach this chat",
      }),
    ).resolves.toEqual({
      status: "failed",
      reason: "model_response_unknown_action",
    });
  });
});
