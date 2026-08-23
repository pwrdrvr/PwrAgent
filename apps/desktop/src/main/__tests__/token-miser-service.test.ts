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
        summary: "The command printed many numbered records.",
        usefulDetails: ["The final record is 4000."],
        suggestedNextStep: "Search for the specific record needed.",
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
    expect(result?.stopReason).toContain("Token Miser intercepted");
    expect(result?.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      response_id: expect.any(String),
    });
    expect(result?.stopReason).toContain("pwragent.read_token_miser_output");
    expect(generateSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
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
        summary: "The script listed many repository files.",
        usefulDetails: ["apps/desktop/src/main/index.ts was present."],
        suggestedNextStep: "Search the stored output for the target package.",
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
        text: expect.stringContaining("Token Miser intercepted"),
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

  it("uses the resolved code-mode budget as the original parent-token cap", async () => {
    const store = await createStore();
    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "ok",
        object: {
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
    token_miser_acceptance_version: 2,
    tool_input: { command: "seq 1 4000" },
    tool_response: output,
  };
}

function codeModePayload(
  contentItems: TokenMiserCodeModeOutputPayload["content_items"],
): TokenMiserCodeModeOutputPayload {
  return {
    version: 2,
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

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}
