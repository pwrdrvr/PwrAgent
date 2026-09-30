import { describe, expect, it } from "vitest";
import type { AcpJsonRpcTransport } from "../acp/acp-client";
import {
  AcpEphemeralPromptError,
  runAcpEphemeralPrompt,
  type AcpEphemeralPromptRequest,
} from "../acp/acp-ephemeral-prompt";

type Handler = (params: Record<string, unknown>, agent: ScriptedAgent) => unknown;

/**
 * An ACP agent scripted per method, shaped after Grok 1.0.44 captures:
 * `configOptions` for model and reasoning effort, `sessionCapabilities.close`,
 * and the model echoed on the prompt reply's `_meta`.
 */
class ScriptedAgent implements AcpJsonRpcTransport {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly notified: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private requestHandler?: (method: string, params: Record<string, unknown>) => unknown;

  constructor(private readonly handlers: Partial<Record<string, Handler>> = {}) {}

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers[method] ?? DEFAULT_HANDLERS[method];
    return handler ? await handler(params ?? {}, this) : {};
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.notified.push({ method, params });
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onRequest(listener: (method: string, params: Record<string, unknown>) => unknown): () => void {
    this.requestHandler = listener;
    return () => { this.requestHandler = undefined; };
  }

  say(text: string): void {
    for (const listener of this.listeners) {
      listener("session/update", {
        sessionId: "grok-session",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
  }

  /** The client's answer to a request the agent makes, or its refusal. */
  async ask(method: string, params: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.requestHandler?.(method, params);
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

const configOptions = (model: string, effort: string) => [
  { id: "model", category: "model", type: "select", currentValue: model,
    options: [{ value: "grok-4.7" }, { value: "grok-4.7-build-fast" }] },
  { id: "reasoning_effort", category: "thought_level", type: "select", currentValue: effort,
    options: [{ value: "high" }, { value: "low" }] },
];

const DEFAULT_HANDLERS: Record<string, Handler> = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {}, close: {} } } }),
  "session/new": () => ({
    sessionId: "grok-session",
    models: { currentModelId: "grok-4.7", availableModels: [{ modelId: "grok-4.7" }, { modelId: "grok-4.7-build-fast" }] },
    configOptions: configOptions("grok-4.7", "high"),
  }),
  // Grok answers a write with the whole menu as it now stands.
  "session/set_config_option": (params) => ({
    configOptions: params.configId === "model"
      ? configOptions(String(params.value), "high")
      : configOptions("grok-4.7-build-fast", String(params.value)),
  }),
  "session/prompt": (_params, agent) => {
    agent.say('{"analysis":');
    agent.say('"Repeated rg output."}');
    return { stopReason: "end_turn", _meta: { modelId: "grok-4.7-build-fast" } };
  },
};

const request: AcpEphemeralPromptRequest = {
  cwd: "/profile/state/acp-helper-workspace",
  prompt: "Analyze.",
  sessionMeta: { agentProfile: { tools: ["read_file"], disallowedTools: ["read_file"] } },
  model: "grok-4.7-build-fast",
  reasoningEffort: "low",
  timeoutMs: 5_000,
  maxOutputChars: 1_000,
  discardMethods: ["_x.ai/session/delete"],
};

describe("ACP ephemeral prompt", () => {
  it("selects the model and effort, answers, and closes and deletes the session", async () => {
    const agent = new ScriptedAgent();

    const result = await runAcpEphemeralPrompt(agent, request);

    expect(result).toEqual({ text: '{"analysis":"Repeated rg output."}', model: "grok-4.7-build-fast", refusedRequests: 0 });
    expect(agent.methods()).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_config_option",
      "session/prompt",
      "session/close",
      "_x.ai/session/delete",
    ]);
    expect(agent.calls[1]?.params).toEqual({
      cwd: "/profile/state/acp-helper-workspace",
      mcpServers: [],
      _meta: request.sessionMeta,
    });
    expect(agent.calls[2]?.params).toEqual({ sessionId: "grok-session", configId: "model", value: "grok-4.7-build-fast" });
    expect(agent.calls[3]?.params).toEqual({ sessionId: "grok-session", configId: "reasoning_effort", value: "low" });
    expect(agent.calls.slice(5).map((call) => call.params)).toEqual([{ sessionId: "grok-session" }, { sessionId: "grok-session" }]);
  });

  it("refuses every permission and client request the agent makes", async () => {
    const answers: unknown[] = [];
    const agent = new ScriptedAgent({
      "session/prompt": async (_params, scripted) => {
        answers.push(await scripted.ask("session/request_permission", {
          sessionId: "grok-session",
          toolCall: { toolCallId: "call-1", title: "pwrgit__pwrgit_repository_roots" },
          options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }],
        }));
        answers.push(await scripted.ask("fs/read_text_file", { sessionId: "grok-session", path: "/etc/hosts" }));
        scripted.say('{"analysis":"Answered without tools."}');
        return { stopReason: "end_turn" };
      },
    });

    const result = await runAcpEphemeralPrompt(agent, request);

    expect(answers).toEqual([
      { outcome: { outcome: "cancelled" } },
      { refused: "fs/read_text_file is not available to this session" },
    ]);
    expect(result).toMatchObject({ text: '{"analysis":"Answered without tools."}', refusedRequests: 2 });
  });

  it("cancels a turn that outlives the budget, and still discards the session", async () => {
    const agent = new ScriptedAgent({ "session/prompt": () => new Promise(() => undefined) });

    const run = runAcpEphemeralPrompt(agent, { ...request, timeoutMs: 30 });

    await expect(run).rejects.toMatchObject({ failure: "timeout", message: "No answer within 1 s." });
    await expect(run).rejects.toBeInstanceOf(AcpEphemeralPromptError);
    expect(agent.notified).toEqual([{ method: "session/cancel", params: { sessionId: "grok-session" } }]);
    expect(agent.methods().slice(-2)).toEqual(["session/close", "_x.ai/session/delete"]);
  });

  it("discards a session the agent creates after the budget has passed", async () => {
    let created: (value: unknown) => void = () => undefined;
    const agent = new ScriptedAgent({
      "session/new": () => new Promise((resolve) => { created = resolve; }),
    });

    const run = runAcpEphemeralPrompt(agent, { ...request, timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    created({ sessionId: "grok-session", configOptions: configOptions("grok-4.7", "high") });

    await expect(run).rejects.toMatchObject({ failure: "timeout" });
    expect(agent.methods()).not.toContain("session/prompt");
    expect(agent.methods().slice(-2)).toEqual(["session/close", "_x.ai/session/delete"]);
  });

  it("cancels an answer that passes the output bound", async () => {
    const agent = new ScriptedAgent({
      "session/prompt": (_params, scripted) => {
        scripted.say("x".repeat(600));
        scripted.say("x".repeat(600));
        return new Promise(() => undefined);
      },
    });

    await expect(runAcpEphemeralPrompt(agent, request)).rejects.toMatchObject({ failure: "output_limit" });
    expect(agent.notified.map((call) => call.method)).toEqual(["session/cancel"]);
  });

  it("never substitutes a model the agent does not offer", async () => {
    const agent = new ScriptedAgent();

    await expect(runAcpEphemeralPrompt(agent, { ...request, model: "grok-9" }))
      .rejects.toMatchObject({ failure: "model_unavailable", message: "The agent does not offer the model grok-9." });
    expect(agent.methods()).not.toContain("session/prompt");
    expect(agent.methods().slice(-2)).toEqual(["session/close", "_x.ai/session/delete"]);
  });

  it("fails a turn the agent stops for any reason but the end of its answer", async () => {
    const agent = new ScriptedAgent({ "session/prompt": () => ({ stopReason: "refusal" }) });

    await expect(runAcpEphemeralPrompt(agent, request))
      .rejects.toMatchObject({ failure: "stopped", message: "The agent stopped the turn (refusal)." });
  });

  it("skips session/close for an agent that does not advertise it", async () => {
    const agent = new ScriptedAgent({ initialize: () => ({ protocolVersion: 1 }) });

    await runAcpEphemeralPrompt(agent, { ...request, discardMethods: [] });

    expect(agent.methods()).not.toContain("session/close");
  });
});
