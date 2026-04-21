import { describe, expect, it } from "vitest";
import { buildXaiProviderOptions } from "../providers/xai-ai-sdk-runtime.js";

describe("buildXaiProviderOptions", () => {
  it("omits reasoning effort for Grok 4.20 Responses models", () => {
    expect(
      buildXaiProviderOptions({
        model: "grok-4.20-reasoning",
        reasoningEffort: "medium",
        previousResponseId: "resp_prev",
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
      }),
    ).toEqual({
      xai: {
        reasoningEffort: "high",
        previousResponseId: "resp_prev",
      },
    });
  });
});
