import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { runInNewContext } from "node:vm";
import { buildAgentMemoryStdioServer } from "../agent-tools/agent-memory-mcp-stdio";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_INDEX_BYTES, AGENT_MEMORY_NOTE_BYTES } from "@pwragent/shared/contracts/agent-memory";
import { buildPwrAgentThreadToolDefinitions } from "../agent-tools/pwragent-thread-agent-tools";
import { AgentMemoryError, AgentMemoryStore } from "../app-server/agent-memory-store";

const authorize = async () => {};
const caller = { backend: "codex", threadId: "caller" } as const;
const other = { backend: "codex", threadId: "other" } as const;

async function withStore(test: (store: AgentMemoryStore) => Promise<void>) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pwragent-memory-property-"));
  try {
    await test(new AgentMemoryStore(path.join(temp, "agent-memory")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

describe("Agent memory owner isolation", () => {
  it("any argument can affect only the memory selected by the trusted caller", async () => {
    await withStore(async (store) => {
      const oracle = await store.access(other, { action: "write_note", noteId: "progress", content: "other thread's record" }, authorize);
      const tool = buildPwrAgentThreadToolDefinitions(async (request) => {
        if (request.operation !== "agent_memory") throw new Error("Unexpected operation");
        try {
          return { ok: true, data: { memory: await store.access(request.context, request.args, authorize) } };
        } catch (error) {
          if (!(error instanceof AgentMemoryError)) throw error;
          return { ok: false, error: { code: "invalid_arguments", message: error.message } };
        }
      }).find(({ name }) => name === "agent_memory");
      expect(tool).toBeDefined();
      const valid = fc.oneof(
        fc.record({ action: fc.constant("read_note"), noteId: fc.constant("progress") }),
        fc.record({ action: fc.constant("write_note"), noteId: fc.constant("progress"), content: fc.string() }),
        fc.record({ action: fc.constant("delete_note"), noteId: fc.constant("progress") }),
      );
      const forged = fc.oneof(
        fc.jsonValue(),
        fc.record({ action: fc.constantFrom("read_note", "write_note", "delete_note"), noteId: fc.constantFrom("../progress", "other/progress", "other\\progress"), content: fc.string() }),
        fc.record({ action: fc.constantFrom("read_note", "write_note", "delete_note"), noteId: fc.constant("progress"), threadId: fc.constant(other.threadId), backend: fc.constant(other.backend), content: fc.string() }),
      );
      await fc.assert(fc.asyncProperty(fc.oneof(valid, forged), fc.constantFrom("codex_dynamic_tool" as const, "mcp" as const), async (args, transport) => {
        const result = await tool!.dispatch(args as Record<string, unknown>, { ...caller, transport });
        expect(JSON.stringify(result)).not.toContain("other thread's record");
        expect(await store.access(other, { action: "read_note", noteId: "progress" }, authorize)).toEqual(oracle);
      }));
    });
  });

  it("rejects oversize writes and stale revisions while preserving saved bytes", async () => {
    await withStore(async (store) => {
      const original = await store.access(caller, { action: "write_index", content: "previous" }, authorize);
      const cap = "é".repeat(AGENT_MEMORY_INDEX_BYTES / 2);
      await expect(store.access(caller, { action: "write_index", content: cap + "a" }, authorize)).rejects.toThrow("4096");
      expect(await store.access(caller, { action: "read_index" }, authorize)).toEqual(original);
      await store.access(caller, { action: "write_index", content: cap }, authorize);
      await expect(store.access(caller, { action: "write_index", content: "stale", revision: "revision" in original ? original.revision : "" }, authorize)).rejects.toThrow("changed");
      await expect(store.access(caller, { action: "write_note", noteId: "progress", content: "é".repeat(AGENT_MEMORY_NOTE_BYTES / 2) + "a" }, authorize)).rejects.toThrow("16384");
      await store.purge(caller);
      expect(await store.access(caller, { action: "read_index" }, authorize)).toMatchObject({ exists: false });
    });
  });
});

it("the ACP stdio bridge forwards MCP frames with its bound credential", async () => {
  const config = buildAgentMemoryStdioServer({
    name: "pwragent", type: "http", url: "http://127.0.0.1:1234/mcp",
    headers: [{ name: "Authorization", value: "Bearer fixture-token" }],
  });
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };
  const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "agent_memory", arguments: { action: "read_index" } } };
  const initialized = { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } };
  const response = { jsonrpc: "2.0", id: 7, result: { content: [] } };
  const written: string[] = [];
  const fetched: unknown[][] = [];
  await runInNewContext(config.args[1]!, {
    AbortSignal,
    process: { env: config.env, stdin: {}, stdout: { write: (line: string) => written.push(line) } },
    require: () => ({ createInterface: () => [JSON.stringify(initialize), JSON.stringify(call)] }),
    fetch: async (...args: unknown[]) => {
      fetched.push(args);
      return fetched.length === 1
        ? { ok: true, status: 200, headers: new Headers({ "mcp-session-id": "fixture-session" }), json: async () => initialized }
        : { ok: true, status: 200, json: async () => response };
    },
  });
  expect(fetched).toEqual([
    [config.env.PWRAGENT_MEMORY_MCP_URL, expect.objectContaining({
      body: JSON.stringify(initialize), headers: expect.objectContaining({ authorization: "Bearer fixture-token" }),
    })],
    [config.env.PWRAGENT_MEMORY_MCP_URL, expect.objectContaining({
      body: JSON.stringify(call), headers: expect.objectContaining({
        authorization: "Bearer fixture-token", "mcp-session-id": "fixture-session", "mcp-protocol-version": "2025-06-18",
      }),
    })],
  ]);
  expect(written).toEqual([JSON.stringify(initialized) + "\n", JSON.stringify(response) + "\n"]);
});
