import { describe, expect, it } from "vitest";
import { buildXaiProviderOptions } from "../providers/xai-ai-sdk-runtime.js";

describe("buildXaiProviderOptions", () => {
  it("passes chat-compatible reasoning effort to xAI provider options", () => {
    expect(
      buildXaiProviderOptions({
        reasoningEffort: "high",
        previousResponseId: "resp_prev",
        mode: "chat",
      }),
    ).toEqual({
      xai: {
        reasoningEffort: "high",
      },
    });
  });

  it("does not pass medium reasoning effort to Chat API models", () => {
    expect(
      buildXaiProviderOptions({
        reasoningEffort: "medium",
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
