import { describe, expect, it } from "vitest";
import {
  normalizeXaiResponse,
  parseNormalizedFunctionArguments,
} from "../providers/response-normalizer.js";
import {
  makeDirectOutputResponse,
  makeXaiFunctionCallResponse,
  makeXaiResponse,
} from "../testing/xai-fixtures.js";

describe("normalizeXaiResponse", () => {
  it("prefers direct output_text when present", () => {
    expect(normalizeXaiResponse(makeDirectOutputResponse())).toEqual({
      assistantText: "Direct output",
      providerResponseId: "resp_direct",
      functionCalls: [],
    });
  });

  it("collects text from message content when output_text is absent", () => {
    expect(normalizeXaiResponse(makeXaiResponse())).toEqual({
      assistantText: "All green.",
      providerResponseId: "resp_123",
      functionCalls: [],
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
      functionCalls: [],
    });
  });

  it("collects function calls from the response output", () => {
    expect(
      normalizeXaiResponse(
        makeXaiFunctionCallResponse({
          id: "resp_tool",
          calls: [
            {
              callId: "call_1",
              name: "search_code",
              argumentsText: JSON.stringify({ query: "needle" }),
            },
          ],
        }),
      ),
    ).toEqual({
      assistantText: "",
      providerResponseId: "resp_tool",
      functionCalls: [
        {
          callId: "call_1",
          name: "search_code",
          argumentsText: "{\"query\":\"needle\"}",
        },
      ],
    });
  });
});

describe("parseNormalizedFunctionArguments", () => {
  it("decodes object arguments", () => {
    expect(
      parseNormalizedFunctionArguments("search_code", "{\"query\":\"needle\"}"),
    ).toEqual({ query: "needle" });
  });

  it("rejects malformed arguments", () => {
    expect(() =>
      parseNormalizedFunctionArguments("search_code", "{"),
    ).toThrow(/arguments must be valid JSON/);
  });
});
