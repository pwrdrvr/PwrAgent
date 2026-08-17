import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentToolRouter } from "../agent-tools/agent-tool-router";
import { buildTokenMiserToolDefinitions } from "../agent-tools/token-miser-agent-tools";
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
});

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-tools-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}
