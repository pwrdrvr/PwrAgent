import { describe, expect, it } from "vitest";
import type { AppServerMcpElicitationRequestNotification } from "@pwragent/shared";
import {
  buildMcpElicitationResponse,
  canAcceptMcpElicitation,
  createMcpElicitationState,
  mcpFieldFormatError,
  redactDisplayValue,
  readMcpApprovalPersistence,
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
  it.each(["session", "always"] as const)("returns the advertised %s approval grant to the server", (persist) => {
    const state = createMcpElicitationState(buildRequest({
      serverName: "cua_repl",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        connector_id: "computer-use",
        tool_params: { app: "Electron" },
        persist: ["session", "always"],
      },
    }))!;

    expect(buildMcpElicitationResponse(state, "accept", persist)).toEqual({
      action: "accept",
      content: {},
      _meta: { persist },
    });
    expect(buildMcpElicitationResponse(state, "decline", persist)._meta).toBeNull();
    expect(buildMcpElicitationResponse(state, "cancel", persist)._meta).toBeNull();
  });

  it("rejects persistence the approval did not advertise", () => {
    const state = createMcpElicitationState(buildRequest({
      _meta: { codex_approval_kind: "mcp_tool_call", persist: "session" },
    }))!;
    expect(() => buildMcpElicitationResponse(state, "accept", "always")).toThrow(/persistence/);
  });

  it.each(["codex_approval_kind", "pwragent_approval_kind"])("accepts server conversation consent only for a host gateway request: %s", (kind) => {
    const state = createMcpElicitationState(buildRequest({
      _meta: { [kind]: "mcp_tool_call", persist: ["session", "server-session"] },
    }))!;
    if (kind === "pwragent_approval_kind") {
      expect(buildMcpElicitationResponse(state, "accept", "server-session")._meta).toEqual({ persist: "server-session" });
    } else {
      expect(readMcpApprovalPersistence(state)).toEqual([]);
      expect(() => buildMcpElicitationResponse(state, "accept", "server-session")).toThrow(/persistence/);
    }
  });

  it.each([
    { persist: "session", expected: ["session"] },
    { persist: "always", expected: ["always"] },
    { persist: ["session", "always"], expected: ["session", "always"] },
    { persist: ["session", "unrestricted"], expected: [] },
    { persist: [], expected: [] },
    { persist: true, expected: [] },
    { persist: undefined, expected: [] },
  ])("offers only valid advertised scopes: $persist", ({ persist, expected }) => {
    const state = createMcpElicitationState(buildRequest({
      _meta: { codex_approval_kind: "mcp_tool_call", persist },
    }))!;
    expect(readMcpApprovalPersistence(state)).toEqual(expected);
  });

  it.each([
    { _meta: { persist: "always" } },
    { mode: "url" as const, url: "https://example.com/login", elicitationId: "login" },
    { requestedSchema: { type: "object" as const, properties: { approved: { type: "boolean" } } } },
  ])("keeps questions and login requests interactive without remembered grants", (params) => {
    const state = createMcpElicitationState(buildRequest({
      _meta: { codex_approval_kind: "mcp_tool_call", persist: "always" },
      ...params,
    }))!;
    expect(readMcpApprovalPersistence(state)).toEqual([]);
    expect(() => buildMcpElicitationResponse(state, "accept", "always")).toThrow(/persistence/);
  });

  it("supports the browser origin approval metadata without approving other servers", () => {
    const request = buildRequest({
      serverName: "browser-use", _meta: { origin: "https://example.com", persist: "always" },
    });
    expect(readMcpApprovalPersistence(createMcpElicitationState(request)!)).toEqual(["always"]);
    request.params.serverName = "unrelated-form";
    expect(readMcpApprovalPersistence(createMcpElicitationState(request)!)).toEqual([]);
  });

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
      elicitationId: "elicitation-1",
      fullUrl: "https://example.test/oauth/start?state=secret-state#fragment",
      host: "example.test",
      internationalHost: false,
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

  it("accepts a 2026-07-28 URL request, which carries no elicitationId", () => {
    const state = createMcpElicitationState(buildRequest({
      mode: "url", requestedSchema: undefined, url: "https://example.test/connect",
    }));

    expect(state?.url).toEqual({
      url: "https://example.test/connect",
      fullUrl: "https://example.test/connect",
      host: "example.test",
      internationalHost: false,
    });
    expect(canAcceptMcpElicitation(state!)).toBe(true);
  });

  it("flags a lookalike international host", () => {
    // Cyrillic "а" in place of the Latin letter.
    const state = createMcpElicitationState(buildRequest({
      mode: "url", requestedSchema: undefined, url: "https://p\u0430ypal.com/login",
    }))!;

    expect(state.url?.host).toMatch(/^xn--/);
    // The full address shows the same punycode, not the imitated name.
    expect(state.url?.fullUrl).toBe(`https://${state.url?.host}/login`);
    expect(state.url?.internationalHost).toBe(true);
  });

  it.each([
    ["javascript:alert(1)", false],
    ["file:///etc/hosts", false],
    ["mailto:pat@example.com", false],
    ["http://example.com/", false],
    ["https://user:pass@example.com/", false],
    ["http://localhost:8123/callback", true],
    ["http://127.0.0.1:8123/callback", true],
    ["https://example.com/", true],
  ])("opens %s only when it is https or loopback http: %s", (url, openable) => {
    const state = createMcpElicitationState(buildRequest({ mode: "url", requestedSchema: undefined, url }))!;

    expect(canAcceptMcpElicitation(state)).toBe(openable);
    expect(Boolean(state.url?.blockedReason)).toBe(!openable);
  });

  it.each([
    ["tool approval", { _meta: { codex_approval_kind: "mcp_tool_call" } }, "tool-approval"],
    ["gateway approval", { _meta: { pwragent_approval_kind: "mcp_tool_call" } }, "tool-approval"],
    ["server confirmation", {}, "confirmation"],
    ["form", { requestedSchema: { type: "object" as const, properties: { note: { type: "string" } } } }, "form"],
    ["link", { mode: "url" as const, requestedSchema: undefined, url: "https://example.com/" }, "url"],
  ])("names a %s by its purpose", (_label, params, purpose) => {
    expect(createMcpElicitationState(buildRequest(params))?.purpose).toBe(purpose);
  });

  it.each([
    ["api_key", {}],
    ["githubToken", {}],
    ["client_secret", {}],
    ["password", {}],
    ["card_number", {}],
    ["pin_code", { format: "password" }],
    ["value", { title: "Access token" }],
    ["value", { writeOnly: true }],
    ["pw", { title: "Password (required)" }],
    ["key", { title: "API key:" }],
    ["value", { title: "Client secret for the CRM app" }],
  ])("refuses to collect a credential field: %s %o", (key, extra) => {
    const state = createMcpElicitationState(buildRequest({
      requestedSchema: { type: "object", properties: { [key]: { type: "string", ...extra } } },
    }))!;

    expect(state.form?.fields[0]?.kind).toBe("secret");
    expect(canAcceptMcpElicitation(state)).toBe(false);
    expect(() => buildMcpElicitationResponse(state, "accept")).not.toThrow();
    expect(buildMcpElicitationResponse(state, "accept").content).toEqual({});
  });

  it.each([
    ["max_tokens", { type: "integer" }],
    ["token_budget", { type: "string" }],
    ["remember_password", { type: "boolean" }],
    ["auth_method", { type: "string", enum: ["token", "password"] }],
    ["secret_question", { type: "string", title: "Secret question" }],
  ])("does not mistake %s for a credential", (key, schema) => {
    const state = createMcpElicitationState(buildRequest({
      requestedSchema: { type: "object", properties: { [key]: schema } },
    }))!;

    expect(state.form?.fields[0]?.kind).not.toBe("secret");
  });

  it.each([
    ["email", "pat@example.com", "pat@", "Enter an email address."],
    ["uri", "https://example.com/a", "example.com", "Enter a full address, such as https://example.com."],
    ["date", "2026-02-28", "2026-02-30", "Enter a date as YYYY-MM-DD."],
    ["date-time", "2026-10-23T14:30:00Z", "2026-10-23 14:30", "Enter a date and time as YYYY-MM-DDTHH:MM:SSZ."],
  ])("validates the %s format", (format, valid, invalid, message) => {
    const state = createMcpElicitationState(buildRequest({
      requestedSchema: { type: "object", properties: { value: { type: "string", format } } },
    }))!;

    const good = updateMcpFieldValue(state, "value", valid);
    const bad = updateMcpFieldValue(state, "value", invalid);
    expect(canAcceptMcpElicitation(good)).toBe(true);
    expect(mcpFieldFormatError(good.form!.fields[0]!)).toBeUndefined();
    expect(canAcceptMcpElicitation(bad)).toBe(false);
    expect(mcpFieldFormatError(bad.form!.fields[0]!)).toBe(message);
    // An optional field may stay empty.
    expect(canAcceptMcpElicitation(state)).toBe(true);
  });

  it("sends a formatted value as it was validated, without padding", () => {
    const state = createMcpElicitationState(buildRequest({
      requestedSchema: { type: "object", properties: {
        email: { type: "string", format: "email" },
        note: { type: "string" },
      } },
    }))!;
    const answered = updateMcpFieldValue(updateMcpFieldValue(state, "email", " pat@example.com "), "note", " as typed ");

    expect(canAcceptMcpElicitation(answered)).toBe(true);
    expect(buildMcpElicitationResponse(answered, "accept").content).toEqual({
      email: "pat@example.com",
      note: " as typed ",
    });
  });
});
