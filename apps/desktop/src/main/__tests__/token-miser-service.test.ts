import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_CONTINUATION_GUIDANCE_V1,
  TokenMiserService,
  type TokenMiserStructuredGenerationResult,
} from "../token-miser/token-miser-service";
import { TokenMiserStore } from "../token-miser/token-miser-store";
import type {
  TokenMiserCodeModeOutputPayload,
  TokenMiserPostToolUsePayload,
} from "../token-miser/token-miser-types";

const temporaryDirectories: string[] = [];

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
    const generateSummary = vi.fn(async () => ({
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
    expect(result?.stopReason).toContain("Token Miser reduced a completed");
    expect(result?.stopReason).toContain("Summary: The command printed");
    expect(result?.stopReason).toContain("Output reference:");
    expect(result?.stopReason).toContain("Full output is available on request.");
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
    expect(generateSummary).not.toHaveBeenCalled();
    expect(await store.listMetadata()).toEqual([]);
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

  // And opt in while it is globally off — the override wins both ways.
  it("lets a thread force the gate on while it is globally off", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => false,
      isEnabledForThread: async () => true,
      generateSummary: summary,
      thresholdCharacters: 1,
    });
    expect(await service.preparePostToolUse(payload("large"))).toBeDefined();
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
});

describe("TokenMiserService code-mode reduction", () => {
  it("stores text output with code-mode context and returns a v2 response id", async () => {
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
        text: expect.stringContaining("Token Miser reduced a completed"),
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
    expect(metadata!.replacementCharacters).toBeGreaterThan(
      replacementText.length,
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
        summary: "A deliberate exact instruction-file read passed through unchanged by policy.",
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
      codeModeContinuationGuidanceVersion: () => 1,
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
      retrieval: { tool: string; policy: string };
    };
    expect(replacement).toMatchObject({
      kind: "token_miser_group_summary",
      groupId: "cell-1",
      members: [
        { toolName: "Bash", summary: "Found alpha matches." },
        { toolName: "Read", summary: "Found beta matches." },
      ],
      retrieval: {
        tool: "pwragent.read_token_miser_output_batch",
        policy: expect.stringContaining("Summaries usually suffice"),
      },
    });
    const [metadata] = await store.listMetadata();
    expect(metadata).toMatchObject({
      groupId: "cell-1",
      originalCharacters: 59,
      groupMembers: replacement.members,
    });
    expect(metadata!.replacementCharacters).toBeGreaterThanOrEqual(
      replacementText.length + CODE_MODE_CONTINUATION_GUIDANCE_V1.length,
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
        summary: expect.stringContaining("live process or session handle"),
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

    await prepareAndCommit(service, {
      ...codeModePayload([{ type: "input_text", text: "x".repeat(1_000) }]),
      max_output_tokens: 25,
    });

    const [metadata] = await store.listMetadata();
    expect(metadata!.baselineParentTokens).toBe(25);
    expect(metadata!.replacementCharacters).toBeLessThanOrEqual(100);
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
      codeModeContinuationGuidanceVersion: () => 1,
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
    expect(metadata!.replacementCharacters).toBeGreaterThanOrEqual(
      authoritativeEnvelope.length + CODE_MODE_CONTINUATION_GUIDANCE_V1.length,
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

  it("fails open before storage when a reducer response exceeds its byte cap", async () => {
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
    tool_input: { command: "seq 1 4000" },
    tool_response: output,
  };
}

function codeModePayload(
  contentItems: TokenMiserCodeModeOutputPayload["content_items"],
): TokenMiserCodeModeOutputPayload {
  return {
    version: 1,
    thread_id: "thread-1",
    turn_id: "turn-1",
    call_id: "call-1",
    cell_id: "cell-1",
    script: "text(await tools.exec_command({ cmd: 'rg --files' }))",
    script_status: "Script completed",
    max_output_tokens: 10_000,
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
