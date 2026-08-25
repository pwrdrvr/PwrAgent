import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildTokenMiserToolDefinitions } from "../agent-tools/token-miser-agent-tools";
import { TokenMiserService } from "../token-miser/token-miser-service";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("Token Miser agent tools", () => {
  it("advertises search, bounded read, and deliberate full read", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "alpha\nneedle\nomega",
      replacementCharacters: 100,
      summary: {
        summary: "A needle is present.",
        usefulDetails: ["needle"],
        suggestedNextStep: "Search for needle.",
      },
    });
    const router = new AgentToolRouter(buildTokenMiserToolDefinitions(store));
    const specs = router.buildDynamicToolSpecs();
    expect(specs[0]).toMatchObject({
      type: "namespace",
      name: "pwragent",
      tools: [
        { name: "search_token_miser_output" },
        { name: "read_token_miser_output" },
        { name: "read_token_miser_output_batch" },
        { name: "read_all_token_miser_output" },
      ],
    });

    const response = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "pwragent",
        tool: "search_token_miser_output",
        arguments: { objectId: metadata.objectId, query: "needle" },
      },
    });
    expect(response.success).toBe(true);
    expect(response.contentItems?.[0]).toMatchObject({ type: "inputText" });

    const grouped = await store.store({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "cell-call-1",
      toolName: "Code Mode",
      output: JSON.stringify({
        version: 1,
        groupId: "cell-1",
        members: [
          {
            objectId: "11111111-1111-4111-8111-111111111111",
            toolCallId: "nested-1",
            toolName: "Bash",
            output: `first\nneedle one\n${"x".repeat(10_000)}\nlast`,
          },
          {
            objectId: "22222222-2222-4222-8222-222222222222",
            toolCallId: "nested-2",
            toolName: "Read",
            output: "alpha\nbeta\ngamma",
          },
        ],
      }),
      baselineCharacters: 20_000,
      replacementCharacters: 800,
      summary: {
        summary: "Two probes completed.",
        usefulDetails: [],
      },
      groupId: "cell-1",
      groupMembers: [
        {
          objectId: "11111111-1111-4111-8111-111111111111",
          toolCallId: "nested-1",
          toolName: "Bash",
          summary: "Found a needle.",
        },
        {
          objectId: "22222222-2222-4222-8222-222222222222",
          toolCallId: "nested-2",
          toolName: "Read",
          summary: "Read three lines.",
        },
      ],
    });
    const batch = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-batch",
        namespace: "pwragent",
        tool: "read_token_miser_output_batch",
        arguments: {
          groupId: "cell-1",
          operations: [
            {
              objectId: "22222222-2222-4222-8222-222222222222",
              mode: "tail",
              lines: 1,
            },
            {
              objectId: "11111111-1111-4111-8111-111111111111",
              mode: "search",
              query: "needle",
            },
            {
              objectId: "11111111-1111-4111-8111-111111111111",
              mode: "full",
            },
          ],
          maxOutputChars: 5_000,
        },
      },
    });
    expect(batch.success).toBe(true);
    const batchContent = batch.contentItems![0]!;
    expect(batchContent.type).toBe("inputText");
    if (batchContent.type !== "inputText") {
      throw new Error("Expected grouped retrieval text.");
    }
    expect(batchContent.text.length).toBeLessThanOrEqual(5_000);
    expect(batchContent.text).toContain("gamma");
    expect(batchContent.text).toContain("2: needle one");
    expect(batchContent.text).toContain("retrieval truncated");
    expect(await store.readAll({
      objectId: grouped.objectId,
      threadId: "thread-1",
    })).toBeUndefined();

    const denied = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-2",
        turnId: "turn-2",
        callId: "call-2",
        namespace: "pwragent",
        tool: "read_all_token_miser_output",
        arguments: { objectId: metadata.objectId },
      },
    });
    expect(denied.success).toBe(false);
  });

  it("counts a retrieval only after recognizable content reaches the Code Mode result", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-1",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Code Mode",
      output: [
        "line one",
        "RECOGNIZABLE_REQUESTED_LINE",
        "line three",
      ].join("\n"),
      replacementCharacters: 100,
      summary: {
        summary: "Three lines were preserved.",
        usefulDetails: [],
      },
    });
    const router = new AgentToolRouter(buildTokenMiserToolDefinitions(store));
    const response = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-2",
        callId: "call-read",
        namespace: "pwragent",
        tool: "read_token_miser_output",
        arguments: {
          objectId: metadata.objectId,
          startLine: 1,
          endLine: 3,
        },
      },
    });
    expect(response.success).toBe(true);
    const dynamicText = response.contentItems?.[0];
    expect(dynamicText?.type).toBe("inputText");
    if (dynamicText?.type !== "inputText") {
      throw new Error("Expected a text dynamic-tool response.");
    }
    expect(dynamicText.text).toContain("RECOGNIZABLE_REQUESTED_LINE");
    expect(dynamicText.text).toContain("pwragent_token_miser_retrieval");
    expect((await store.readMetadata(metadata.objectId))?.retrievedCharacters)
      .toBe(0);

    const service = new TokenMiserService({
      store,
      isEnabled: () => true,
      generateSummary: async () => ({
        status: "failed",
        reason: "retrieval cells must bypass the reducer",
      }),
      thresholdCharacters: 1,
    });
    const retrievalScript =
      `const r = await tools.pwragent__read_token_miser_output({ objectId: "${metadata.objectId}", startLine: 1, endLine: 3 }); for (const c of (r?.content ?? [])) if (c.type === "text") text(c.text);`;
    expect(await service.prepareCodeModeOutput({
      version: 2,
      thread_id: "thread-1",
      turn_id: "turn-2",
      call_id: "call-code-mode-empty",
      cell_id: "cell-retrieval-empty",
      script_status: "completed",
      max_output_tokens: 10_000,
      script: retrievalScript,
      content_items: [{
        type: "input_text",
        text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
      }],
    })).toBeUndefined();
    expect((await store.readMetadata(metadata.objectId))?.retrievedCharacters)
      .toBe(0);

    const deliveredResponse = await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        threadId: "thread-1",
        turnId: "turn-2",
        callId: "call-read-delivered",
        namespace: "pwragent",
        tool: "read_token_miser_output",
        arguments: {
          objectId: metadata.objectId,
          startLine: 1,
          endLine: 3,
        },
      },
    });
    const deliveredText = deliveredResponse.contentItems?.[0];
    if (deliveredText?.type !== "inputText") {
      throw new Error("Expected a delivered text dynamic-tool response.");
    }
    const emitted = deliveredText.text;
    expect(await service.prepareCodeModeOutput({
      version: 2,
      thread_id: "thread-1",
      turn_id: "turn-2",
      call_id: "call-code-mode",
      cell_id: "cell-retrieval",
      script_status: "completed",
      max_output_tokens: 10_000,
      script:
        `const r = await tools.pwragent__read_token_miser_output({ objectId: "${metadata.objectId}", startLine: 1, endLine: 3 }); text(r);`,
      content_items: [{ type: "input_text", text: emitted }],
    })).toBeUndefined();
    expect((await store.readMetadata(metadata.objectId))?.retrievedCharacters)
      .toBeGreaterThanOrEqual("RECOGNIZABLE_REQUESTED_LINE".length);
    expect(await store.summarizeThreadUsage("thread-1")).toMatchObject({
      codeMode: { retrievalCount: 2 },
    });
  });
});

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-tools-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}
