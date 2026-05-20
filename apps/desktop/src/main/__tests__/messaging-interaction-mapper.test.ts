import { describe, expect, it, vi } from "vitest";
import type {
  MessagingApprovalIntent,
  MessagingConfirmationIntent,
  MessagingQuestionnaireIntent,
  MessagingSingleSelectIntent,
} from "@pwragent/messaging-interface";
import { DeterministicInteractionMapper } from "../messaging/core/deterministic-interaction-mapper";
import {
  CodexModelInteractionMapperClient,
  FallbackModelInteractionMapperClient,
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
        {
          id: "command:status",
          label: "Status",
          description: "show the current binding and controls",
          fallbackText: "/status",
        },
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
          expect.objectContaining({
            id: "command:status",
            description: "show the current binding and controls",
            index: 2,
          }),
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

describe("FallbackModelInteractionMapperClient", () => {
  it("uses the first available model client", async () => {
    const codex: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "action" as const,
        actionId: "command:status",
        confidence: 0.8,
      })),
    };
    const grok: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "action" as const,
        actionId: "command:monitor",
        confidence: 0.8,
      })),
    };
    const client = new FallbackModelInteractionMapperClient([codex, grok]);

    await expect(
      client.classify({
        intent: { kind: "confirmation" },
        actions: [
          { id: "command:status", label: "Status", index: 1 },
          { id: "command:monitor", label: "Monitor", index: 2 },
        ],
        text: "show state",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      actionId: "command:status",
    });
    expect(grok.classify).not.toHaveBeenCalled();
  });

  it("falls back when the preferred model client is unavailable", async () => {
    const codex: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "unavailable" as const,
        reason: "codex_unavailable",
      })),
    };
    const grok: ModelInteractionMapperClient = {
      classify: vi.fn(async () => ({
        status: "ok" as const,
        disposition: "pass_through" as const,
        confidence: 0.77,
      })),
    };
    const client = new FallbackModelInteractionMapperClient([codex, grok]);

    await expect(
      client.classify({
        intent: { kind: "confirmation" },
        actions: [{ id: "command:status", label: "Status", index: 1 }],
        text: "compact",
      }),
    ).resolves.toMatchObject({
      status: "ok",
      disposition: "pass_through",
    });
    expect(codex.classify).toHaveBeenCalledOnce();
    expect(grok.classify).toHaveBeenCalledOnce();
  });
});

describe("CodexModelInteractionMapperClient", () => {
  it("uses the Codex helper object path with the mapper prompt and schema", async () => {
    const helper = {
      generateHelperObject: vi.fn(async () => ({
        status: "ok" as const,
        object: {
          disposition: "action",
          actionId: "command:monitor",
          confidence: 0.83,
        },
      })),
    };
    const client = new CodexModelInteractionMapperClient({
      helper,
      timeoutMs: 4321,
    });

    await expect(
      client.classify({
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
    expect(helper.generateHelperObject).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "messaging-interaction-mapper-v1",
        schemaName: "messaging_interaction_mapping",
        timeoutMs: 4321,
        prompt: expect.stringContaining("start watching this"),
      }),
    );
    expect(helper.generateHelperObject).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("map a dictated or typed messaging reply"),
      }),
    );
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
