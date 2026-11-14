import { afterEach, beforeEach, expect, it } from "vitest";
import { OPENAI_DECISIONS_TOOL_NAMES } from "@pwragent/shared/openai-decisions";
import { resolveAgentToolCatalogs } from "../agent-tool-catalog-registry";
import type { PwrAgentOpenAIDecisionsHandler } from "../pwragent-openai-decisions-agent-tools";
import { OpenAIDecisionsService } from "../../openai-decisions/openai-decisions-service";
import { OpenAIDecisionStore } from "../../storage/openai-decision-store";
import type { StateDb } from "../../state/state-db";
import { openInMemoryStateDb } from "../../__tests__/sqlite-test-utils";

const TEST_KEY = "sk-test-openai-decisions-tools-0123456789";

let db: StateDb;
let handler: PwrAgentOpenAIDecisionsHandler;
let fetches: number;

beforeEach(() => {
  db = openInMemoryStateDb();
  fetches = 0;
  const service = new OpenAIDecisionsService({
    store: new OpenAIDecisionStore(db),
    readApiKey: async () => TEST_KEY,
    readAccountSettings: () => ({}),
    profileId: () => "test-profile",
    recordUsageLines: async () => undefined,
    fetch: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { message: `bad key ${TEST_KEY}` } }), {
        status: 401,
        headers: { "x-request-id": "req_tools" },
      });
    },
  });
  handler = {
    register: (caller, args) => service.register(caller, args),
    list: (caller, args) => service.list(caller, args),
    invoke: async (caller, args, signal) => await service.invoke(caller, args, signal),
    update: (caller, args) => service.update(caller, args),
    delete: (caller, args) => service.delete(caller, args),
  };
});
afterEach(() => db.close());

function decisionsCatalog() {
  const catalog = resolveAgentToolCatalogs({ openAIDecisionsHandler: handler })
    .find((candidate) => candidate.id === "openai_decisions");
  if (!catalog) throw new Error("openai_decisions catalog missing");
  return catalog;
}

function toolNames(catalog: ReturnType<typeof decisionsCatalog>) {
  return {
    dynamic: catalog.dynamicTools.flatMap((tool) =>
      tool.type === "namespace" ? tool.tools.map((nested) => `${tool.name}/${nested.name}`) : [tool.name]),
    mcp: catalog.router.buildMcpTools().map((tool) => tool.name),
  };
}

it("publishes the same five fixed tools as Codex dynamic tools and on the MCP server", async () => {
  const catalog = decisionsCatalog();
  expect(catalog.summary).toMatchObject({ id: "openai_decisions", enabled: true, toolCount: 5 });
  const before = toolNames(catalog);
  expect(before.dynamic).toEqual(OPENAI_DECISIONS_TOOL_NAMES.map((name) => `pwragent/${name}`));
  expect(before.mcp).toEqual(expect.arrayContaining([...OPENAI_DECISIONS_TOOL_NAMES]));
  expect(before.mcp).toHaveLength(5);
  const advertised = JSON.stringify([catalog.dynamicTools, catalog.router.buildMcpTools()]);
  expect(advertised).not.toMatch(/sk-|openaiDecisionsApiKey|Bearer /);

  // Registering a decision adds a row, never a tool.
  await catalog.router.handleMcpToolCall({
    backend: "claude",
    threadId: "thread-mcp",
    tool: "decisions_register",
    args: {
      name: "route_support_ticket",
      instructions: "Which queue should handle this ticket?",
      question: { type: "choice", choices: [{ value: "billing" }, { value: "other" }] },
      inputSchema: { type: "string" },
    },
  });
  expect(toolNames(decisionsCatalog())).toEqual(before);
  expect(JSON.stringify(decisionsCatalog().dynamicTools)).not.toContain("route_support_ticket");
});

it("dispatches through both transports to one shared registry", async () => {
  const { router } = decisionsCatalog();
  const registered = await router.handleDynamicToolCall({
    backend: "codex",
    call: {
      threadId: "thread-codex",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "pwragent",
      tool: "decisions_register",
      arguments: {
        name: "route_support_ticket",
        instructions: "Which queue should handle this ticket?",
        question: { type: "choice", choices: [{ value: "billing" }, { value: "other" }] },
        inputSchema: { type: "string" },
      },
    },
  });
  expect(registered.success).toBe(true);

  const listed = await router.handleMcpToolCall({
    backend: "claude",
    threadId: "thread-mcp",
    namespace: "pwragent",
    tool: "decisions_list",
    args: {},
  });
  expect(JSON.stringify(listed)).toContain("route_support_ticket");

  const rejected = await router.handleMcpToolCall({
    backend: "claude",
    threadId: "thread-mcp",
    tool: "decisions_invoke",
    args: { name: "route_support_ticket", input: "Charged twice." },
  });
  expect(fetches).toBe(1);
  const text = JSON.stringify(rejected);
  expect(text).toContain("credential_rejected");
  expect(text).toContain("req_tools");
  expect(text).not.toContain(TEST_KEY);

  const invalid = await router.handleDynamicToolCall({
    backend: "codex",
    call: {
      threadId: "thread-codex",
      turnId: "turn-1",
      callId: "call-2",
      namespace: "pwragent",
      tool: "decisions_invoke",
      arguments: { name: "route_support_ticket", input: { not: "a string" } },
    },
  });
  expect(invalid.success).toBe(false);
  expect(JSON.stringify(invalid)).toContain("invalid_input");
  expect(fetches).toBe(1);
});

it("fails closed without a handler", async () => {
  const catalog = resolveAgentToolCatalogs({}).find((candidate) => candidate.id === "openai_decisions")!;
  expect(catalog.summary.enabled).toBe(false);
  const result = await catalog.router.handleMcpToolCall({
    backend: "codex",
    threadId: "thread-a",
    tool: "decisions_list",
    args: {},
  });
  expect(JSON.stringify(result)).toContain("internal_error");
});
