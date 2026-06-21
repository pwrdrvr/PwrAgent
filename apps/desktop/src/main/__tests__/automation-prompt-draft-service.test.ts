import { describe, expect, it, vi } from "vitest";
import { generateAutomationPromptDraft } from "../app-server/automation-prompt-draft-service";

describe("generateAutomationPromptDraft", () => {
  it("returns a drafted prompt from the generator object", async () => {
    const generate = vi.fn(async (_request: { prompt: string }) => ({
      status: "ok" as const,
      object: { prompt: "  Investigate the alert in the incoming message.  " },
    }));

    const result = await generateAutomationPromptDraft({
      description: "tell me what's wrong when Datadog alerts",
      generate,
    });

    expect(result).toEqual({
      status: "generated",
      prompt: "Investigate the alert in the incoming message.",
    });
    expect(generate).toHaveBeenCalledTimes(1);
    // The drafter sends only the operator's description, never message content.
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      prompt: "tell me what's wrong when Datadog alerts",
    });
  });

  it("propagates an unavailable backend without calling normalization", async () => {
    const result = await generateAutomationPromptDraft({
      description: "investigate alerts",
      generate: async () => ({ status: "unavailable", reason: "acp_structured_generation_unavailable" }),
    });

    expect(result).toEqual({
      status: "unavailable",
      reason: "acp_structured_generation_unavailable",
    });
  });

  it("rejects an empty description without calling the generator", async () => {
    const generate = vi.fn();
    const result = await generateAutomationPromptDraft({
      description: "   ",
      generate,
    });

    expect(result).toEqual({ status: "invalid", reason: "empty_description" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("flags a non-string prompt payload as invalid", async () => {
    const result = await generateAutomationPromptDraft({
      description: "investigate alerts",
      generate: async () => ({ status: "ok", object: { prompt: 42 } }),
    });

    expect(result).toEqual({ status: "invalid", reason: "prompt_must_be_string" });
  });
});
