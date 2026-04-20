import { describe, expect, it } from "vitest";
import { buildXaiProviderOptions } from "../providers/xai-ai-sdk-runtime.js";

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

  it("preserves Responses API reasoning effort and previous response id", () => {
    expect(
      buildXaiProviderOptions({
        reasoningEffort: "medium",
        previousResponseId: "resp_prev",
        mode: "responses",
      }),
    ).toEqual({
      xai: {
        reasoningEffort: "medium",
        previousResponseId: "resp_prev",
      },
    });
  });
});
