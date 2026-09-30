import { describe, expect, it, vi } from "vitest";
import { AcpEphemeralPromptError, type AcpEphemeralPromptRequest } from "../acp/acp-ephemeral-prompt";
import { generateAcpStructuredObject, hasAcpStructuredHelper } from "../app-server/acp-structured-generation";

const schema = { type: "object", properties: { analysis: { type: "string" } }, required: ["analysis"], additionalProperties: false };

function generate(answer: string | Error) {
  const run = vi.fn(async (_request: AcpEphemeralPromptRequest) => {
    if (answer instanceof Error) throw answer;
    return { text: answer, model: "grok-4.7-build-fast", refusedRequests: 0 };
  });
  const result = generateAcpStructuredObject({
    backend: "acp:grok", cwd: "/profile/state/acp-helper-workspace", run,
    model: "grok-4.7-build-fast", reasoningEffort: "low",
    system: "Diagnose cost drivers.", prompt: "<transcript>…</transcript>",
    schema, isMatch: (value) => typeof value.analysis === "string", turnTimeoutMs: 90_000,
  });
  return { run, result };
}

describe("ACP structured generation", () => {
  it("runs Grok with no tools, the schema in both prompts, and a bounded budget", async () => {
    const { run, result } = generate('```json\n{"analysis":"Two identical rg dumps."}\n```');

    await expect(result).resolves.toEqual({
      status: "ok", object: { analysis: "Two identical rg dumps." },
      model: "grok-4.7-build-fast", reasoningEffort: "low",
    });
    const request = run.mock.calls[0]![0];
    expect(request).toMatchObject({
      cwd: "/profile/state/acp-helper-workspace",
      model: "grok-4.7-build-fast", reasoningEffort: "low",
      timeoutMs: 90_000, maxOutputChars: 32_000,
      discardMethods: ["_x.ai/session/delete"],
    });
    const meta = request.sessionMeta as { agentProfile: Record<string, unknown>; systemPromptOverride: string };
    expect(meta.agentProfile).toMatchObject({
      tools: ["read_file"],
      disallowedTools: ["read_file", "search_tool", "use_tool"],
      injectDefaultTools: false,
      mcpInheritance: "none",
    });
    expect(meta.systemPromptOverride).toContain("Diagnose cost drivers.\nYou have no tools.");
    expect(meta.systemPromptOverride).toContain(JSON.stringify(schema));
    expect(request.prompt).toMatch(/^<transcript>…<\/transcript>\n\nReply with only one JSON object/);
    expect(request.prompt).toContain(JSON.stringify(schema));
  });

  it.each([
    ["prose", "The parenthetical number dominates."],
    ["a missing required field", '{"summary":"Two dumps."}'],
    ["a field the schema forbids", '{"analysis":"Two dumps.","confidence":0.9}'],
    ["a field of the wrong type", '{"analysis":42}'],
    ["an empty answer", ""],
  ])("fails an answer with %s", async (_case, answer) => {
    await expect(generate(answer).result).resolves.toEqual({
      status: "failed", reason: "Grok did not answer with the requested JSON.",
    });
  });

  it("reports a timeout in the operator's terms", async () => {
    const { result } = generate(new AcpEphemeralPromptError("timeout", "No answer within 90 s."));

    await expect(result).resolves.toEqual({ status: "failed", reason: "Grok did not answer within 90 s." });
  });

  it("reports an agent that cannot start", async () => {
    const { result } = generate(new Error("ACP backend authentication required: acp:grok"));

    await expect(result).resolves.toEqual({
      status: "failed", reason: "Grok is unavailable: ACP backend authentication required: acp:grok",
    });
  });

  it("offers no structured helper for an agent without a tool-less profile", async () => {
    const run = vi.fn();

    await expect(generateAcpStructuredObject({
      backend: "acp:kimi", cwd: "/tmp", run, system: "", prompt: "", schema, turnTimeoutMs: 1_000,
    })).resolves.toEqual({ status: "unavailable", reason: "acp:kimi_structured_generation_unavailable" });
    expect(run).not.toHaveBeenCalled();
    expect(hasAcpStructuredHelper("acp:grok")).toBe(true);
    expect(hasAcpStructuredHelper("acp:kimi")).toBe(false);
  });
});
