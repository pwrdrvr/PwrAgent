import { describe, expect, it, vi } from "vitest";
import { generateAutomationPromptDraft } from "../app-server/automation-prompt-draft-service";

describe("generateAutomationPromptDraft", () => {
  it("returns a drafted prompt from the model object", async () => {
    const generateObject = vi.fn(async () => ({
      object: { prompt: "  Investigate the alert in the incoming message.  " },
    }));

    const result = await generateAutomationPromptDraft({
      apiKey: "test-key",
      client: { generateObject },
      description: "tell me what's wrong when Datadog alerts",
    });

    expect(result).toEqual({
      status: "generated",
      prompt: "Investigate the alert in the incoming message.",
    });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when no xAI key or client is configured", async () => {
    const result = await generateAutomationPromptDraft({
      description: "investigate alerts",
    });

    expect(result.status).toBe("unavailable");
  });

  it("rejects an empty description without calling the model", async () => {
    const generateObject = vi.fn();
    const result = await generateAutomationPromptDraft({
      apiKey: "test-key",
      client: { generateObject },
      description: "   ",
    });

    expect(result).toEqual({ status: "invalid", reason: "empty_description" });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("flags a non-string prompt payload as invalid", async () => {
    const result = await generateAutomationPromptDraft({
      apiKey: "test-key",
      client: { generateObject: async () => ({ object: { prompt: 42 } }) },
      description: "investigate alerts",
    });

    expect(result).toEqual({ status: "invalid", reason: "prompt_must_be_string" });
  });
});
