import { describe, expect, it } from "vitest";
import { normalizeXaiResponse } from "../providers/response-normalizer.js";
import { makeDirectOutputResponse, makeXaiResponse } from "../testing/xai-fixtures.js";

describe("normalizeXaiResponse", () => {
  it("prefers direct output_text when present", () => {
    expect(normalizeXaiResponse(makeDirectOutputResponse())).toEqual({
      assistantText: "Direct output",
      providerResponseId: "resp_direct",
    });
  });

  it("collects text from message content when output_text is absent", () => {
    expect(normalizeXaiResponse(makeXaiResponse())).toEqual({
      assistantText: "All green.",
      providerResponseId: "resp_123",
    });
  });

  it("returns an empty assistant string when no text is present", () => {
    expect(
      normalizeXaiResponse({
        id: "resp_empty",
        output: [{ type: "message", content: [] }],
      }),
    ).toEqual({
      assistantText: "",
      providerResponseId: "resp_empty",
    });
  });
});
