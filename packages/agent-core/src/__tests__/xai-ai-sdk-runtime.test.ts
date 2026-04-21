import { describe, expect, it } from "vitest";
import { buildXaiProviderOptions } from "../providers/xai-ai-sdk-runtime.js";
import { selectGrokModelMode } from "../providers/xai-model-selection.js";

describe("buildXaiProviderOptions", () => {
  it("does not pass reasoning effort to Chat API models", () => {
    expect(
      buildXaiProviderOptions({
        reasoningEffort: "high",
        previousResponseId: "resp_prev",
        mode: "chat",
      }),
    ).toBeUndefined();
  });

  it("omits reasoning effort for Grok 4.20 Responses models", () => {
    expect(
      buildXaiProviderOptions({
        model: "grok-4.20-reasoning",
        reasoningEffort: "medium",
        previousResponseId: "resp_prev",
        mode: "responses",
      }),
    ).toEqual({
      xai: {
        previousResponseId: "resp_prev",
      },
    });
  });

  it("preserves reasoning effort for Grok multi-agent Responses models", () => {
    expect(
      buildXaiProviderOptions({
        model: "grok-4.20-multi-agent-0309",
        reasoningEffort: "high",
        previousResponseId: "resp_prev",
        mode: "responses",
      }),
    ).toEqual({
      xai: {
        reasoningEffort: "high",
        previousResponseId: "resp_prev",
      },
    });
  });
});

describe("selectGrokModelMode", () => {
  it("uses Responses API for Grok 4.x models", () => {
    expect(selectGrokModelMode("grok-4.20-reasoning")).toBe("responses");
    expect(selectGrokModelMode("grok-4.20-non-reasoning")).toBe("responses");
    expect(selectGrokModelMode("grok-4-1-fast-reasoning")).toBe("responses");
  });

  it("falls back to Chat API for known non-Responses model families", () => {
    expect(selectGrokModelMode("grok-code-fast-1")).toBe("chat");
    expect(selectGrokModelMode("grok-3")).toBe("chat");
  });
});
