import { describe, expect, it } from "vitest";
import type { AppServerMcpElicitationRequestNotification } from "@pwragnt/shared";
import {
  buildMcpElicitationResponse,
  canAcceptMcpElicitation,
  createMcpElicitationState,
  redactDisplayValue,
  updateMcpFieldValue,
} from "../mcp-elicitation";

function buildRequest(
  params: Partial<AppServerMcpElicitationRequestNotification["params"]>
): AppServerMcpElicitationRequestNotification {
  return {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "mcp-request-1",
      serverName: "playwright",
      mode: "form",
      _meta: null,
      message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
      requestedSchema: {
        type: "object",
        properties: {},
      },
      ...params,
    },
  };
}

describe("MCP elicitation helpers", () => {
  it("accepts empty-schema form approvals with MCP response shape", () => {
    const state = createMcpElicitationState(buildRequest({}));

    expect(state).toBeDefined();
    expect(state?.form).toMatchObject({
      empty: true,
      fields: [],
    });
    expect(canAcceptMcpElicitation(state!)).toBe(true);
    expect(buildMcpElicitationResponse(state!, "accept")).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  it("declines and cancels with null content", () => {
    const state = createMcpElicitationState(buildRequest({}))!;

    expect(buildMcpElicitationResponse(state, "decline")).toEqual({
      action: "decline",
      content: null,
      _meta: null,
    });
    expect(buildMcpElicitationResponse(state, "cancel")).toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });
  });

  it("validates required string fields and submits content", () => {
    const state = createMcpElicitationState(
      buildRequest({
        requestedSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: {
              type: "string",
              title: "Search query",
              description: "The search text.",
              minLength: 2,
            },
          },
        },
      })
    )!;

    expect(canAcceptMcpElicitation(state)).toBe(false);

    const answered = updateMcpFieldValue(state, "query", "tabs");

    expect(canAcceptMcpElicitation(answered)).toBe(true);
    expect(buildMcpElicitationResponse(answered, "accept")).toEqual({
      action: "accept",
      content: {
        query: "tabs",
      },
      _meta: null,
    });
  });

  it("preserves boolean, number, and enum field values", () => {
    const state = createMcpElicitationState(
      buildRequest({
        requestedSchema: {
          type: "object",
          required: ["count", "target"],
          properties: {
            includeClosed: {
              type: "boolean",
              title: "Include closed",
              default: true,
            },
            count: {
              type: "integer",
              title: "Count",
              minimum: 1,
              maximum: 10,
            },
            target: {
              type: "string",
              title: "Target",
              oneOf: [
                { const: "tabs", title: "Tabs" },
                { const: "windows", title: "Windows" },
              ],
            },
          },
        },
      })
    )!;

    const withCount = updateMcpFieldValue(state, "count", 3);
    const answered = updateMcpFieldValue(withCount, "target", "tabs");

    expect(canAcceptMcpElicitation(answered)).toBe(true);
    expect(buildMcpElicitationResponse(answered, "accept")).toEqual({
      action: "accept",
      content: {
        includeClosed: true,
        count: 3,
        target: "tabs",
      },
      _meta: null,
    });
  });

  it("supports multi-select enum arrays", () => {
    const state = createMcpElicitationState(
      buildRequest({
        requestedSchema: {
          type: "object",
          required: ["scopes"],
          properties: {
            scopes: {
              type: "array",
              title: "Scopes",
              minItems: 1,
              items: {
                anyOf: [
                  { const: "repo", title: "Repository" },
                  { const: "issues", title: "Issues" },
                ],
              },
            },
          },
        },
      })
    )!;

    expect(canAcceptMcpElicitation(state)).toBe(false);

    const answered = updateMcpFieldValue(state, "scopes", ["repo", "issues"]);

    expect(canAcceptMcpElicitation(answered)).toBe(true);
    expect(buildMcpElicitationResponse(answered, "accept")).toEqual({
      action: "accept",
      content: {
        scopes: ["repo", "issues"],
      },
      _meta: null,
    });
  });

  it("preserves URL mode without embedding URL details in response content", () => {
    const state = createMcpElicitationState(
      buildRequest({
        turnId: null,
        serverName: "github",
        mode: "url",
        message: "Authorize GitHub access.",
        requestedSchema: undefined,
        url: "https://example.test/oauth/start?state=secret-state#fragment",
        elicitationId: "elicitation-1",
      })
    );

    expect(state).toBeDefined();
    expect(state?.url).toEqual({
      url: "https://example.test/oauth/start?state=secret-state#fragment",
      displayUrl: "https://example.test/oauth/start",
      elicitationId: "elicitation-1",
    });
    expect(canAcceptMcpElicitation(state!)).toBe(true);
    expect(buildMcpElicitationResponse(state!, "accept")).toEqual({
      action: "accept",
      content: {},
      _meta: null,
    });
  });

  it("blocks required unsupported fields", () => {
    const state = createMcpElicitationState(
      buildRequest({
        requestedSchema: {
          type: "object",
          required: ["payload"],
          properties: {
            payload: {
              type: "object",
              title: "Payload",
            },
          },
        },
      })
    );

    expect(state).toBeDefined();
    expect(state?.form?.fields[0]).toMatchObject({
      kind: "unsupported",
      key: "payload",
      required: true,
    });
    expect(canAcceptMcpElicitation(state!)).toBe(false);
  });

  it("rejects malformed requests", () => {
    expect(
      createMcpElicitationState(
        buildRequest({
          requestId: "",
        })
      )
    ).toBeUndefined();
    expect(
      createMcpElicitationState(
        buildRequest({
          requestedSchema: undefined,
        })
      )
    ).toBeUndefined();
    expect(
      createMcpElicitationState(
        buildRequest({
          mode: "url",
          requestedSchema: undefined,
          url: "",
          elicitationId: "elicitation-1",
        })
      )
    ).toBeUndefined();
  });

  it("redacts tokens and URL query strings for display", () => {
    expect(redactDisplayValue("Bearer abc123")).toBe("[redacted]");
    expect(redactDisplayValue("abc123def456ghi789jkl012mno345pq")).toBe("[redacted]");
    expect(redactDisplayValue("https://example.test/path?token=secret#frag")).toBe(
      "https://example.test/path"
    );
  });
});
