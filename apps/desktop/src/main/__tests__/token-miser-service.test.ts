import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TokenMiserService,
  type TokenMiserStructuredGenerationResult,
} from "../token-miser/token-miser-service";
import { TokenMiserStore } from "../token-miser/token-miser-store";
import type {
  TokenMiserCodeModeOutputPayload,
  TokenMiserPostToolUsePayload,
} from "../token-miser/token-miser-types";
import {
  TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
  TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS,
  utf8ByteLength,
} from "../token-miser/token-miser-types";

const temporaryDirectories: string[] = [];
const BEHAVIOR_PRIMING_LANGUAGE =
  /token miser|reduc\w*|model-visible cap|output limit|\bbounded\b|\bcompact\b|\bnarrow\b|context savings/i;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("TokenMiserService", () => {
  it("replaces large output with a summary and a retrievable object id", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "The command printed many numbered records.",
        usefulDetails: ["The final record is 4000."],
      },
      helperThreadId: "helper-thread-1",
      helperTurnId: "helper-turn-1",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      serviceTier: "priority",
      tokenUsage: { inputTokens: 2_000, outputTokens: 80 },
    }));
    const onInterceptionStored = vi.fn();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      getParentCumulativeInputTokens: () => 12_345,
      generateSummary,
      onInterceptionStored,
      thresholdCharacters: 9,
    });

    const prepared = await service.preparePostToolUse(payload("1\n2\n3\n4000"));
    const result = prepared?.hookOutput;

    expect(result?.continue).toBe(false);
    expect(result?.stopReason).toContain("Summary: The command printed");
    expect(result?.stopReason).toContain("Output reference:");
    expect(result?.stopReason).toContain(
      "Original output is temporary (up to five minutes); expiry, eviction or restart makes it unavailable.",
    );
    expect(result?.stopReason).not.toMatch(BEHAVIOR_PRIMING_LANGUAGE);
    expect(result?.stopReason).not.toMatch(/suggested next step/i);
    expect(result?.stopReason).not.toContain("pwragent.");
    expect(result?.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      response_id: expect.any(String),
    });
    expect(generateSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        system: expect.stringContaining(
          "Do not recommend actions, searches, reads, refinements, or next steps.",
        ),
        schema: expect.objectContaining({
          required: ["disposition", "summary", "usefulDetails"],
        }),
      }),
    );
    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringMatching(
        /sed range read[\s\S]*distinct[\s\S]*source code[\s\S]*pass_through/i,
      ),
    }));
    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.stringMatching(
        /sed result[\s\S]*repetitive data[\s\S]*repeated error[\s\S]*summarize/i,
      ),
    }));
    expect(await store.listMetadata()).toEqual([]);
    expect(onInterceptionStored).not.toHaveBeenCalled();
    await prepared?.staged.persist();
    expect(await store.listMetadata()).toEqual([]);
    await prepared?.staged.commit();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "tool-1",
      originalCharacters: 10,
      replayTrackingVersion: 2,
      lastParentCumulativeInputTokens: 12_345,
      helperUsage: {
        helperThreadId: "helper-thread-1",
        helperTurnId: "helper-turn-1",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        serviceTier: "priority",
      },
    });
    expect(onInterceptionStored).toHaveBeenCalledWith(metadata);
    expect(result?.stopReason).toContain(metadata!.objectId);
    expect(result?.hookSpecificOutput.response_id).toBe(metadata!.objectId);
  });

  it("passes an exact instruction read through without paying for evaluation", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "pass_through",
        summary: "A focused read returned the requested instruction file.",
        usefulDetails: ["The output is coherent and directly matches the stated intent."],
      },
      helperThreadId: "helper-pass-through",
      helperTurnId: "helper-turn-pass-through",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 1_000, outputTokens: 40 },
    }));
    const onInterceptionStored = vi.fn();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      onInterceptionStored,
      thresholdCharacters: 9,
    });

    const request = {
      ...payload("exact instruction text"),
      parent_intent: "I need to read the desktop AGENTS.md before editing.",
      tool_input: { command: "sed -n '1,220p' apps/desktop/AGENTS.md" },
    };
    expect(await service.preparePostToolUse(request)).toBeUndefined();

    expect(generateSummary).not.toHaveBeenCalled();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      originalCharacters: 22,
      baselineParentTokens: 6,
      replacementCharacters: 22,
      retrievedCharacters: 0,
    });
    expect(metadata?.helperUsage).toBeUndefined();
    expect(await store.readAll({
      objectId: metadata!.objectId,
      threadId: "thread-1",
    })).toBeUndefined();
    expect(await store.summarizeThreadUsage("thread-1")).toMatchObject({
      interceptionCount: 1,
      passThroughCount: 1,
      estimatedParentTokensSaved: 0,
      replacementTokens: 6,
    });
    expect(onInterceptionStored).toHaveBeenCalledWith(metadata);
  });

  it("fails open for disabled, small, and failed-summary output", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "offline",
    }));
    const disabled = new TokenMiserService({
      store,
      isEnabled: () => false,
      generateSummary,
      thresholdCharacters: 1,
    });
    expect(await disabled.preparePostToolUse(payload("large"))).toBeUndefined();

    const enabled = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 100,
    });
    expect(await enabled.preparePostToolUse(payload("small"))).toBeUndefined();

    const failing = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    expect(await failing.preparePostToolUse(payload("large"))).toBeUndefined();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("does not gate Code Mode nested calls that never enter parent context", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not run",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    expect(await service.preparePostToolUse({
      ...payload("large nested output"),
      is_code_mode_nested: true,
    })).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await store.listMetadata()).toEqual([]);
  });

  it.each([
    "search_token_miser_output",
    "read_token_miser_output",
    "read_all_token_miser_output",
    "read_token_miser_output_batch",
  ])("does not re-gate a direct %s retrieval", async (tool) => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not run",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    expect(await service.preparePostToolUse({
      ...payload("preserved output"),
      tool_name: "pwragent",
      tool_input: { tool, objectId: "object-1" },
    })).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("caps direct retrieval accounting at the ordinary 10k-token result limit", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "tool-source",
      toolName: "Code Mode",
      output: "中".repeat(30_000),
      replacementCharacters: 100,
      summary: { summary: "Large source", usefulDetails: [] },
    });
    const result = await store.readAll({
      objectId: metadata.objectId,
      threadId: "thread-1",
    });
    const delivery = await store.prepareRetrievalDelivery({
      objectId: metadata.objectId,
      threadId: "thread-1",
      visibleText: result!.text,
    });
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "failed",
        reason: "retrievals bypass Luna",
      }),
      thresholdCharacters: 1,
    });

    await service.preparePostToolUse({
      ...payload(delivery!.text),
      tool_name: "pwragent",
      tool_input: {
        tool: "read_all_token_miser_output",
        objectId: metadata.objectId,
      },
    });

    const retrievedBytes = (await store.readMetadata(
      metadata.objectId,
    ))!.retrievedCharacters;
    expect(retrievedBytes).toBeGreaterThan(39_000);
    expect(retrievedBytes).toBeLessThanOrEqual(
      TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS
      * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });

  it("does not mistake a direct source search for Token Miser retrieval", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "Source references were listed.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    expect(await service.preparePostToolUse({
      ...payload("large source-search output"),
      tool_input: { command: "rg read_all_token_miser_output apps/desktop" },
    })).toBeDefined();
    expect(generateSummary).toHaveBeenCalledOnce();
  });

  it("fails open without both direct-result protocol markers", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not run",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    const unsupported = payload("large unmarked output") as Partial<
      TokenMiserPostToolUsePayload
    >;
    delete unsupported.is_code_mode_nested;

    expect(
      await service.preparePostToolUse(
        unsupported as TokenMiserPostToolUsePayload,
      ),
    ).toBeUndefined();
    const sourceMarkerOnly = payload("large unversioned output") as Partial<
      TokenMiserPostToolUsePayload
    >;
    delete sourceMarkerOnly.token_miser_acceptance_version;
    expect(
      await service.preparePostToolUse(
        sourceMarkerOnly as TokenMiserPostToolUsePayload,
      ),
    ).toBeUndefined();
    const legacyResponseOnly = payload("large legacy hook output") as Partial<
      TokenMiserPostToolUsePayload
    >;
    delete legacyResponseOnly.token_miser_exact_tool_response;
    delete legacyResponseOnly.token_miser_exact_tool_response_version;
    expect(
      await service.preparePostToolUse(
        legacyResponseOnly as TokenMiserPostToolUsePayload,
      ),
    ).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("uses only the capability-advertised exact response for direct gating", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "summarize" as const,
        summary: "The exact output contained the requested result.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      postToolUseExactOutputVersion: () => 1,
      generateSummary,
      thresholdCharacters: 100,
    });
    const request = payload("legacy truncated output");
    request.token_miser_exact_tool_response = "exact output\n".repeat(100);

    expect(await service.preparePostToolUse(request)).toBeDefined();
    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("exact output"),
    }));
    expect(generateSummary).not.toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("legacy truncated output"),
    }));
  });
});

describe("TokenMiserService per-thread override", () => {
  const summary = vi.fn(async () => ({
    status: "ok" as const,
    helperThreadId: "helper",
    helperTurnId: "helper-turn",
    model: "gpt-5.6-luna",
    reasoningEffort: "medium" as const,
    object: {
      disposition: "summarize",
      summary: "Large output.",
      usefulDetails: [],
      suggestedNextStep: "None.",
    },
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }));

  // A thread can opt out of the helper round trip when latency matters more
  // than context, without touching the global setting.
  it("lets a thread force the gate off while it is globally on", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      isEnabledForThread: async (threadId) =>
        threadId === "thread-1" ? false : undefined,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeUndefined();
    expect(summary).not.toHaveBeenCalled();
  });

  it("keeps the global experimental flag as the outer gate", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => false,
      isEnabledForThread: async () => true,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeUndefined();
    expect(summary).not.toHaveBeenCalled();
  });

  it("inherits an off thread default while the experiment remains available", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      isEnabledByDefault: () => false,
      isEnabledForThread: async () => undefined,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeUndefined();
    expect(summary).not.toHaveBeenCalled();
  });

  it("allows a thread to opt in when the inherited default is off", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      isEnabledByDefault: () => false,
      isEnabledForThread: async () => true,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeDefined();
    expect(summary).toHaveBeenCalledTimes(1);
  });

  it("follows the global setting when no override is set", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => false,
      isEnabledForThread: async () => undefined,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeUndefined();
  });

  it("reserves Luna capacity for direct tool output after large metadata", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize" as const,
        summary: "The source marker was available.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    await service.preparePostToolUse({
      ...payload(`${"o".repeat(30_000)}DIRECT_OUTPUT_GOLD`),
      parent_intent: "intent metadata ".repeat(10_000),
      tool_input: { query: "input metadata ".repeat(10_000) },
    });

    const request = generateSummary.mock.calls[0]![0];
    expect(request.prompt).toContain("Tool output:\n");
    expect(request.prompt).toContain("DIRECT_OUTPUT_GOLD");
    expect(
      utf8ByteLength(request.prompt) + utf8ByteLength(request.system),
    ).toBeLessThanOrEqual(
      20_000 * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });
});

describe("TokenMiserService code-mode reduction", () => {
  it("limits Luna to 20k projected input tokens while retaining the second 10k", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "The bounded source contained the requested marker.",
        usefulDetails: [],
      },
      helperThreadId: "helper-thread-code-mode",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 20_000, outputTokens: 40 },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    const secondWindowGold = "SECOND_TEN_THOUSAND_TOKEN_GOLD";
    const beyondHelperCap = "BEYOND_LUNA_SOURCE_CAP";
    const output = [
      "a".repeat(50_000),
      secondWindowGold,
      "b".repeat(35_000),
      beyondHelperCap,
      "c".repeat(50_000),
    ].join("");

    await service.prepareCodeModeOutput(codeModePayload([{
      type: "input_text",
      text: output,
    }]));

    const request = generateSummary.mock.calls[0]![0];
    const prompt = request.prompt;
    expect(prompt).toContain(secondWindowGold);
    expect(prompt).not.toContain(beyondHelperCap);
    expect(utf8ByteLength(prompt) + utf8ByteLength(request.system)).toBeLessThanOrEqual(
      20_000 * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });

  it("applies Luna's projected input cap in UTF-8 bytes for CJK output", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize" as const,
        summary: "The bounded source was inspected.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    const withinByteBudget = "CJK_WITHIN_BYTE_BUDGET";
    const beyondByteBudget = "CJK_BEYOND_BYTE_BUDGET";
    const output = [
      "中".repeat(15_000),
      withinByteBudget,
      "文".repeat(13_000),
      beyondByteBudget,
    ].join("");

    await service.prepareCodeModeOutput(codeModePayload([{
      type: "input_text",
      text: output,
    }]));

    const request = generateSummary.mock.calls[0]![0];
    expect(request.prompt).toContain(withinByteBudget);
    expect(request.prompt).not.toContain(beyondByteBudget);
    expect(
      utf8ByteLength(request.prompt) + utf8ByteLength(request.system),
    ).toBeLessThanOrEqual(
      20_000 * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });

  it("reserves Luna capacity for script output after a large script", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize" as const,
        summary: "The script output marker was available.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: `${"o".repeat(30_000)}SCRIPT_OUTPUT_GOLD`,
      }]),
      parent_intent: "intent metadata ".repeat(10_000),
      script: "const metadata = 'x';\n".repeat(10_000),
    });

    const request = generateSummary.mock.calls[0]![0];
    expect(request.prompt).toContain("Script output:\n");
    expect(request.prompt).toContain("SCRIPT_OUTPUT_GOLD");
    expect(
      utf8ByteLength(request.prompt) + utf8ByteLength(request.system),
    ).toBeLessThanOrEqual(
      20_000 * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });

  it("stores text output with neutral code-mode context and authoritative overhead", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "The script listed many repository files.",
        usefulDetails: ["apps/desktop/src/main/index.ts was present."],
      },
      helperThreadId: "helper-thread-code-mode",
      helperTurnId: "helper-turn-code-mode",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 1_000, outputTokens: 60 },
    }));
    const onInterceptionStored = vi.fn();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      onInterceptionStored,
      thresholdCharacters: 9,
    });
    const request = codeModePayload([
      { type: "input_text", text: "apps/desktop/\n" },
      { type: "input_text", text: "packages/shared/\n" },
    ]);

    const result = await prepareAndCommit(service, request);

    expect(result).toEqual({
      replacement: [{
        type: "input_text",
        text: expect.stringContaining("Summary: The script listed many repository files."),
      }],
      response_id: expect.any(String),
    });
    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      prompt: expect.stringMatching(
        /Call ID: call-1[\s\S]*Cell ID: cell-1[\s\S]*rg --files/,
      ),
    }));
    const [metadata] = await store.listMetadata();
    const replacementText = result!.replacement![0]!.text;
    expect(metadata).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "call-1",
      toolName: "Code Mode",
      originalCharacters: 31,
      baselineParentTokens: 8,
    });
    expect(result).toMatchObject({ response_id: metadata!.objectId });
    expect(replacementText).not.toMatch(BEHAVIOR_PRIMING_LANGUAGE);
    expect(metadata!.replacementCharacters).toBe(
      replacementText.length + request.model_visible_overhead_characters,
    );
    expect(onInterceptionStored).toHaveBeenCalledWith(metadata);
  });

  it("passes a bounded exact source read through without evaluation", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "pass_through",
        summary: "The requested source file was read successfully.",
        usefulDetails: [],
      },
      helperThreadId: "helper-code-pass-through",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 500, outputTokens: 20 },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 9,
    });
    const request = {
      ...codeModePayload([{
        type: "input_text" as const,
        text: "requested source content",
      }]),
      parent_intent: "Read the exact source before changing it.",
      script: "text(await tools.exec_command({ cmd: \"sed -n '1,220p' source.ts\" }))",
    };

    expect(await service.prepareCodeModeOutput(request)).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      baselineParentTokens: 6,
      replacementCharacters: 24,
    });
    expect(metadata?.helperUsage).toBeUndefined();
  });

  it("accounts only the original 10k-token result when Luna passes through", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "pass_through",
          summary: "The requested result should pass through.",
          usefulDetails: [],
        },
        helperThreadId: "helper-pass-through",
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        tokenUsage: { inputTokens: 20_000, outputTokens: 20 },
      }),
      thresholdCharacters: 1,
    });

    expect(await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: "中".repeat(20_000),
      }]),
      script: "text(await tools.exec_command({ cmd: 'focused-query' }))",
    })).toBeUndefined();

    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      baselineParentTokens: TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS,
      replacementCharacters:
        TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS
        * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
      helperUsage: {
        helperThreadId: "helper-pass-through",
        model: "gpt-5.6-luna",
      },
    });
  });

  it("exempts a mandatory Code Mode instruction read deterministically", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not run",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 9,
    });
    const request = {
      ...codeModePayload([{
        type: "input_text" as const,
        text: "mandatory instruction contents",
      }]),
      script:
        "const result = await tools.exec_command({ cmd: \"sed -n '1,240p' apps/desktop/AGENTS.md\" }); text(result.output);",
    };

    expect(await service.prepareCodeModeOutput(request)).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      summary: {
        summary: "Output passed through.",
      },
    });
    expect(metadata?.helperUsage).toBeUndefined();
    expect((await store.summarizeThreadUsage("thread-1")).codeMode)
      .toMatchObject({
        callCount: 1,
        passThroughCount: 1,
        directCount: 0,
      });
  });

  it("charges pre-reduction nested captures to the shared original-output budget", async () => {
    const store = await createStore();
    const original = await store.store({
      threadId: "thread-1", turnId: "turn-1", toolUseId: "original", toolName: "Bash",
      output: "original", replacementCharacters: 10,
      summary: { summary: "Output summarized.", usefulDetails: [] },
    });
    let enabled = true;
    const service = new TokenMiserService({
      store, isEnabled: () => enabled, codeModeGroupingVersion: () => 1,
      generateSummary: async () => ({ status: "unavailable", reason: "fixture" }),
    });
    for (let index = 0; index < 16; index += 1) {
      await service.captureNestedPostToolUse({
        ...payload("x".repeat(900_000)), is_code_mode_nested: true,
        token_miser_grouping_version: 1, code_mode_cell_id: `budget-${index}`,
        code_mode_tool_call_id: "nested",
      });
    }
    expect(await store.readAll({ objectId: original.objectId, threadId: "thread-1" })).toBeUndefined();
    enabled = false;
    for (let index = 0; index < 16; index += 1) {
      await service.prepareCodeModeOutput({ ...codeModePayload([]), cell_id: `budget-${index}` });
    }
  });

  it("joins parallel nested outputs into one retrievable group gate", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "Two independent repository probes completed.",
        usefulDetails: ["Both probes returned source matches."],
        members: [
          { toolCallId: "nested-1", summary: "Found alpha matches." },
          { toolCallId: "nested-2", summary: "Found beta matches." },
        ],
      },
      helperThreadId: "helper-group",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 500, outputTokens: 50 },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 10,
      codeModeGroupingVersion: () => 1,
    });
    await service.captureNestedPostToolUse({
      ...payload("alpha\nneedle-alpha\nomega"),
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-1",
      tool_name: "Bash",
    });
    await service.captureNestedPostToolUse({
      ...payload("beta\nneedle-beta\ngamma"),
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-2",
      tool_name: "Read",
    });

    const prepared = await service.prepareCodeModeOutput(codeModePayload([{
      type: "input_text",
      text: "combined outer output that crosses the configured threshold",
    }]));
    await prepared?.staged.commit();

    expect(generateSummary).toHaveBeenCalledOnce();
    expect(generateSummary).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringMatching(
        /Group ID: cell-1[\s\S]*nested-1[\s\S]*needle-alpha[\s\S]*nested-2[\s\S]*needle-beta/,
      ),
      schema: expect.objectContaining({
        required: ["disposition", "summary", "usefulDetails"],
      }),
    }));
    const replacementText = prepared!.response.replacement[0]!.text;
    const replacement = JSON.parse(replacementText) as {
      kind: string;
      groupId: string;
      members: Array<{ objectId: string; toolName: string; summary: string }>;
      sourceMaterial?: string;
    };
    expect(replacement).toMatchObject({
      kind: "tool_output_group_summary",
      groupId: "cell-1",
      members: [
        { toolName: "Bash", summary: "Found alpha matches." },
        { toolName: "Read", summary: "Found beta matches." },
      ],
      sourceMaterial: "Temporary: expires within five minutes; unavailable after eviction or restart.",
    });
    expect(replacementText).not.toMatch(BEHAVIOR_PRIMING_LANGUAGE);
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      groupId: "cell-1",
      originalCharacters: 59,
      groupMembers: replacement.members.map((member) => ({ ...member, summary: "Output summarized." })),
    });
    expect(metadata!.replacementCharacters).toBe(
      replacementText.length
      + codeModePayload([]).model_visible_overhead_characters,
    );
    const batch = await store.readGroupBatch({
      groupId: "cell-1",
      threadId: "thread-1",
      operations: [
        {
          objectId: replacement.members[1]!.objectId,
          mode: "search",
          query: "needle",
        },
        {
          objectId: replacement.members[0]!.objectId,
          mode: "head",
          lines: 1,
        },
      ],
      maxOutputChars: 5_000,
    });
    expect(batch).toMatchObject({
      groupId: "cell-1",
      results: [
        { objectId: replacement.members[1]!.objectId, text: "2: needle-beta" },
        { objectId: replacement.members[0]!.objectId, text: "alpha" },
      ],
    });
    expect((await store.readMetadata(metadata!.objectId))!.retrievedCharacters)
      .toBe(0);
  });

  it("keeps every group recovery ID in a capped replacement", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "group summary ".repeat(100),
          usefulDetails: [],
          members: [
            { toolCallId: "nested-1", summary: "first summary ".repeat(50) },
            { toolCallId: "nested-2", summary: "second summary ".repeat(50) },
          ],
        },
      }),
      thresholdCharacters: 1,
      codeModeGroupingVersion: () => 1,
    });
    for (const [toolCallId, output] of [
      ["nested-1", "first preserved output"],
      ["nested-2", "second preserved output"],
    ] as const) {
      await service.captureNestedPostToolUse({
        ...payload(output),
        is_code_mode_nested: true,
        token_miser_grouping_version: 1,
        code_mode_cell_id: "cell-1",
        code_mode_tool_call_id: toolCallId,
      });
    }

    const prepared = await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: "combined grouped output",
      }]),
      max_output_tokens: 150,
    });

    expect(prepared).toBeDefined();
    await prepared!.staged.commit();
    const replacement = prepared!.response.replacement[0]!.text;
    expect(utf8ByteLength(replacement)).toBeLessThanOrEqual(600);
    expect(() => JSON.parse(replacement)).not.toThrow();
    const [metadata] = await store.listMetadata();
    expect(replacement).toContain("cell-1");
    for (const member of metadata!.groupMembers!) {
      expect(replacement).toContain(member.objectId);
    }
  });

  it("shares Luna's 20k projected-input cap across every grouped member", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async (_request: {
      prompt: string;
      system: string;
    }) => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "Both grouped probes completed.",
        usefulDetails: [],
        members: [
          { toolCallId: "nested-1", summary: "First result." },
          { toolCallId: "nested-2", summary: "Second result." },
        ],
      },
      helperThreadId: "helper-group-cap",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 20_000, outputTokens: 50 },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
      codeModeGroupingVersion: () => 1,
    });
    await service.captureNestedPostToolUse({
      ...payload(`${"a".repeat(15_000)}FIRST_MEMBER_GOLD${"a".repeat(45_000)}`),
      tool_input: { query: "first metadata ".repeat(10_000) },
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-1",
    });
    await service.captureNestedPostToolUse({
      ...payload(`${"b".repeat(15_000)}SECOND_MEMBER_GOLD${"b".repeat(45_000)}`),
      tool_input: { query: "second metadata ".repeat(10_000) },
      is_code_mode_nested: true,
      token_miser_grouping_version: 1,
      code_mode_cell_id: "cell-1",
      code_mode_tool_call_id: "nested-2",
    });

    await service.prepareCodeModeOutput(codeModePayload([{
      type: "input_text",
      text: "combined grouped output",
    }]));

    const request = generateSummary.mock.calls[0]![0];
    expect(request.prompt).toContain("FIRST_MEMBER_GOLD");
    expect(request.prompt).toContain("SECOND_MEMBER_GOLD");
    expect(
      utf8ByteLength(request.prompt) + utf8ByteLength(request.system),
    ).toBeLessThanOrEqual(
      20_000 * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
  });

  it("passes a coherent parallel group through without running a second generic evaluation", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "pass_through",
        summary: "Both requested focused reads completed.",
        usefulDetails: [],
      },
      helperThreadId: "helper-group-pass-through",
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: { inputTokens: 500, outputTokens: 40 },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 10,
      codeModeGroupingVersion: () => 1,
    });
    for (const [toolCallId, output] of [
      ["nested-1", "focused alpha content"],
      ["nested-2", "focused beta content"],
    ]) {
      await service.captureNestedPostToolUse({
        ...payload(output),
        is_code_mode_nested: true,
        token_miser_grouping_version: 1,
        code_mode_cell_id: "cell-1",
        code_mode_tool_call_id: toolCallId,
      });
    }

    expect(await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: "combined focused result above threshold",
      }]),
      parent_intent: "Read both exact files in parallel.",
    })).toBeUndefined();
    expect(generateSummary).toHaveBeenCalledOnce();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      baselineParentTokens: 10,
      replacementCharacters: 39,
    });
    expect(metadata?.groupId).toBeUndefined();
    expect(metadata?.groupMembers).toBeUndefined();
  });

  it("passes through parallel nonterminal results so their polling handles remain visible", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not evaluate actionable session state",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 10,
      codeModeGroupingVersion: () => 1,
    });
    for (const [toolCallId, toolResponse] of [
      [
        "typecheck-call",
        {
          status: "running",
          session_id: 101,
          chunk_id: "typecheck-1",
          output: "Typecheck is still running.",
        },
      ],
      [
        "eslint-call",
        {
          status: "running",
          session_id: 102,
          chunk_id: "eslint-1",
          output: "ESLint is still running.",
        },
      ],
    ] as const) {
      await service.captureNestedPostToolUse({
        ...payload("unused"),
        is_code_mode_nested: true,
        token_miser_grouping_version: 1,
        code_mode_cell_id: "cell-1",
        code_mode_tool_call_id: toolCallId,
        tool_name: "exec_command",
        tool_input: { cmd: toolCallId },
        tool_response: toolResponse,
        token_miser_exact_tool_response: toolResponse,
      });
    }

    expect(await service.prepareCodeModeOutput(codeModePayload([{
      type: "input_text",
      text: [
        "Both commands are running.",
        "typecheck session_id=101 chunk_id=typecheck-1",
        "eslint session_id=102 chunk_id=eslint-1",
      ].join("\n"),
    }]))).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      disposition: "passed_through",
      toolName: "Code Mode",
      summary: {
        summary: "Output passed through.",
      },
    });
    expect(metadata?.helperUsage).toBeUndefined();
    expect(await store.summarizeThreadUsage("thread-1")).toMatchObject({
      codeMode: {
        callCount: 1,
        commandCellCount: 1,
        nestedCommandInvocationCount: 2,
        multiInvocationClusterCount: 1,
      },
    });
  });

  it("uses the resolved code-mode budget as the original parent-token cap", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "A long script result.",
          usefulDetails: [],
          suggestedNextStep: "Read a narrow range if needed.",
        },
      }),
      thresholdCharacters: 1,
    });

    const response = await prepareAndCommit(service, {
      ...codeModePayload([{ type: "input_text", text: "x".repeat(1_000) }]),
      max_output_tokens: 25,
    });

    const [metadata] = await store.listMetadata();
    const replacement = response!.replacement![0]!.text;
    expect(replacement.length).toBeLessThanOrEqual(100);
    expect(replacement).toContain(`Output reference: ${metadata!.objectId}`);
    expect(metadata!.baselineParentTokens).toBe(25);
    expect(metadata!.replacementCharacters).toBeLessThanOrEqual(
      100 + codeModePayload([]).model_visible_overhead_characters,
    );
    expect(metadata!.replacementCharacters).toBeGreaterThan(
      codeModePayload([]).model_visible_overhead_characters,
    );
  });

  it("fails open when the recovery reference cannot fit the resolved budget", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "A long script result.",
          usefulDetails: [],
        },
      }),
      thresholdCharacters: 1,
    });

    expect(await service.prepareCodeModeOutput({
      ...codeModePayload([{ type: "input_text", text: "x".repeat(1_000) }]),
      max_output_tokens: 5,
    })).toBeUndefined();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("echoes Codex actionable state exactly and accounts for its model-visible envelope", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "Two validations are still running.",
          usefulDetails: [],
        },
      }),
      thresholdCharacters: 1,
    });
    const actionableState = codeModeActionableState();

    const response = await prepareAndCommit(service, {
      ...codeModePayload([{
        type: "input_text",
        text: "Long validation output that the reducer may summarize.",
      }]),
      actionable_state: actionableState,
    });

    expect(response).toMatchObject({
      actionable_state: actionableState,
      response_id: expect.any(String),
    });
    const [metadata] = await store.listMetadata();
    const authoritativeEnvelope =
      `<codex_actionable_state>${JSON.stringify(actionableState)}</codex_actionable_state>`;
    const replacementText = response!.replacement![0]!.text;
    expect(metadata!.replacementCharacters).toBe(
      replacementText.length
      + codeModePayload([]).model_visible_overhead_characters
      + authoritativeEnvelope.length,
    );
  });

  it.each([
    {
      tool: "search_token_miser_output",
      script:
        "const result = await tools.pwragent__search_token_miser_output({ objectId: 'object-1', query: 'needle' }); text(result);",
    },
    {
      tool: "read_token_miser_output",
      script:
        "const result = await tools.pwragent.read_token_miser_output({ objectId: 'object-1' }); text(result);",
    },
    {
      tool: "read_all_token_miser_output",
      script:
        "const result = await tools.pwragent({ tool: 'read_all_token_miser_output', objectId: 'object-1' }); text(result);",
    },
    {
      tool: "read_token_miser_output_batch",
      script:
        "const result = await tools.pwragent__read_token_miser_output_batch({ groupId: 'cell-1', operations: [] }); text(result);",
    },
  ])("does not re-gate a Code Mode $tool retrieval", async ({ script }) => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "must not run",
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    expect(await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: "deliberately retrieved output",
      }]),
      script,
    })).toBeUndefined();
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("shares the 10k parent cap across multiple retrievals in one Code Mode cell", async () => {
    const store = await createStore();
    const source = async (objectId: string, fill: string) => {
      const metadata = await store.store({
        objectId,
        threadId: "thread-1",
        turnId: "turn-1",
        toolUseId: `tool-${fill}`,
        toolName: "Code Mode",
        output: fill.repeat(30_000),
        replacementCharacters: 100,
        summary: { summary: `${fill} source`, usefulDetails: [] },
      });
      const result = await store.readAll({ objectId, threadId: "thread-1" });
      const delivery = await store.prepareRetrievalDelivery({
        objectId,
        threadId: "thread-1",
        visibleText: result!.text,
      });
      return { delivery: delivery!.text, metadata };
    };
    const first = await source("11111111-1111-4111-8111-111111111111", "a");
    const second = await source("22222222-2222-4222-8222-222222222222", "b");
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "failed",
        reason: "retrieval cells bypass Luna",
      }),
      thresholdCharacters: 1,
    });

    await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: `${first.delivery}\n${second.delivery}`,
      }]),
      script: [
        "const one = await tools.pwragent__read_all_token_miser_output({ objectId: 'one' });",
        "const two = await tools.pwragent__read_all_token_miser_output({ objectId: 'two' });",
        "text(one); text(two);",
      ].join("\n"),
    });

    const firstUpdated = await store.readMetadata(first.metadata.objectId);
    const secondUpdated = await store.readMetadata(second.metadata.objectId);
    expect(firstUpdated!.retrievedCharacters).toBeGreaterThan(15_000);
    expect(secondUpdated!.retrievedCharacters).toBeGreaterThan(15_000);
    const retrievedCharacters =
      firstUpdated!.retrievedCharacters + secondUpdated!.retrievedCharacters;
    expect(retrievedCharacters).toBeGreaterThan(30_000);
    expect(retrievedCharacters).toBeLessThanOrEqual(
      TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS
      * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );

    for (const cumulativeInputTokens of [1_000, 2_000, 3_000]) {
      await Promise.all([
        store.recordParentModelRequest({
          cumulativeInputTokens,
          objectId: first.metadata.objectId,
        }),
        store.recordParentModelRequest({
          cumulativeInputTokens,
          objectId: second.metadata.objectId,
        }),
      ]);
    }
    const replayedFirst = await store.readMetadata(first.metadata.objectId);
    const replayedSecond = await store.readMetadata(second.metadata.objectId);
    expect(
      replayedFirst!.cachedRevealedTokens!
      + replayedSecond!.cachedRevealedTokens!,
    ).toBeLessThanOrEqual(TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS + 50);
  });

  it("does not mistake a Code Mode source search for Token Miser retrieval", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "ok" as const,
      object: {
        disposition: "summarize",
        summary: "Source references were listed.",
        usefulDetails: [],
      },
    }));
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });

    expect(await service.prepareCodeModeOutput({
      ...codeModePayload([{
        type: "input_text",
        text: "large source-search output",
      }]),
      script: "text(await tools.exec_command({ cmd: 'rg read_all_token_miser_output apps/desktop' }))",
    })).toBeDefined();
    expect(generateSummary).toHaveBeenCalledOnce();
  });

  it("fails open for disabled, small, and failed-summary code-mode output", async () => {
    const store = await createStore();
    const generateSummary = vi.fn(async () => ({
      status: "failed" as const,
      reason: "offline",
    }));
    const disabled = new TokenMiserService({
      store,
      isEnabled: () => false,
      generateSummary,
      thresholdCharacters: 1,
    });
    expect(
      await disabled.prepareCodeModeOutput(
        codeModePayload([{ type: "input_text", text: "large" }]),
      ),
    ).toBeUndefined();

    const enabled = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 100,
    });
    expect(
      await enabled.prepareCodeModeOutput(
        codeModePayload([{ type: "input_text", text: "small" }]),
      ),
    ).toBeUndefined();

    const failing = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    expect(
      await failing.prepareCodeModeOutput(
        codeModePayload([{ type: "input_text", text: "large" }]),
      ),
    ).toBeUndefined();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("does not store a late helper result after Codex disconnects", async () => {
    const store = await createStore();
    let resolveGeneration!: (
      result: TokenMiserStructuredGenerationResult,
    ) => void;
    const generateSummary = vi.fn(
      () => new Promise<TokenMiserStructuredGenerationResult>((resolve) => {
        resolveGeneration = resolve;
      }),
    );
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary,
      thresholdCharacters: 1,
    });
    const controller = new AbortController();
    const pending = service.prepareCodeModeOutput(
      codeModePayload([{ type: "input_text", text: "large output" }]),
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(generateSummary).toHaveBeenCalledOnce());

    controller.abort();
    resolveGeneration({
      status: "ok",
      object: {
        disposition: "summarize",
        summary: "This arrived too late.",
        usefulDetails: [],
        suggestedNextStep: "None.",
      },
    });

    expect(await pending).toBeUndefined();
    expect(await store.listMetadata()).toEqual([]);
  });

  it("caps a multibyte reducer response before the bridge byte cap", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "😀".repeat(20_000),
          usefulDetails: [],
          suggestedNextStep: "Read a narrow range if needed.",
        },
      }),
      thresholdCharacters: 1,
    });

    const prepared = await service.prepareCodeModeOutput(
      codeModePayload([{ type: "input_text", text: "large output" }]),
    );
    expect(prepared).toBeDefined();
    const replacement = prepared!.response.replacement[0]!.text;
    expect(utf8ByteLength(replacement)).toBeLessThanOrEqual(
      TOKEN_MISER_MODEL_VISIBLE_CAP_TOKENS
      * TOKEN_MISER_ESTIMATED_BYTES_PER_TOKEN,
    );
    expect(Buffer.byteLength(`${JSON.stringify(prepared!.response)}\n`)).toBeLessThan(
      64 * 1024,
    );
  });

  it("fails open before storage when escaped response bytes exceed the bridge cap", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
          disposition: "summarize",
          summary: "\\".repeat(40_000),
          usefulDetails: [],
          suggestedNextStep: "Read a narrow range if needed.",
        },
      }),
      thresholdCharacters: 1,
    });

    await expect(
      service.prepareCodeModeOutput(
        codeModePayload([{ type: "input_text", text: "large output" }]),
      ),
    ).resolves.toBeUndefined();
    expect(await store.listMetadata()).toEqual([]);
  });
});

async function prepareAndCommit(
  service: TokenMiserService,
  request: TokenMiserCodeModeOutputPayload,
) {
  const prepared = await service.prepareCodeModeOutput(request);
  await prepared?.staged.commit();
  return prepared?.response;
}

function payload(output: string): TokenMiserPostToolUsePayload {
  return {
    session_id: "thread-1",
    turn_id: "turn-1",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "tool-1",
    is_code_mode_nested: false,
    token_miser_acceptance_version: 1,
    token_miser_exact_tool_response_version: 1,
    tool_input: { command: "seq 1 4000" },
    tool_response: output,
    token_miser_exact_tool_response: output,
  };
}

function codeModePayload(
  contentItems: TokenMiserCodeModeOutputPayload["content_items"],
): TokenMiserCodeModeOutputPayload & {
  model_visible_overhead_characters: number;
} {
  return {
    version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    call_id: "call-1",
    cell_id: "cell-1",
    script: "text(await tools.exec_command({ cmd: 'rg --files' }))",
    script_status: "Script completed",
    max_output_tokens: 10_000,
    model_visible_overhead_characters: 137,
    content_items: contentItems,
  };
}

function codeModeActionableState() {
  return {
    version: 1 as const,
    entries: [{
      session_id: 101,
      process_id: 101,
      chunk_id: "typecheck-1",
      state: "running" as const,
      exit_code: null,
      required_follow_up: {
        operation: "write_stdin" as const,
        arguments: { session_id: 101, chars: "" },
      },
    }],
  };
}

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}
