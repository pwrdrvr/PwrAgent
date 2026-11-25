import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ACP_AGENT_ELICITATION_META_KEY,
  mcpElicitationPurpose,
} from "../mcp-elicitation-purpose";

describe("mcpElicitationPurpose", () => {
  it("names a form an agent question only when the ACP client marked it (oracle)", () => {
    const properties = fc.option(fc.dictionary(
      fc.string({ minLength: 1, maxLength: 6 }),
      fc.constant({ type: "string" }),
      { maxKeys: 3 },
    ), { nil: undefined });
    const meta = fc.option(fc.record({
      [ACP_AGENT_ELICITATION_META_KEY]: fc.option(fc.oneof(fc.boolean(), fc.constant("true"), fc.integer()), { nil: undefined }),
      pwragent_approval_kind: fc.option(fc.constant("mcp_tool_call"), { nil: undefined }),
    }), { nil: null });

    fc.assert(fc.property(
      fc.constantFrom("form" as const, "url" as const),
      fc.constantFrom("Antigravity", "playwright", "browser"),
      properties,
      meta,
      (mode, serverName, props, _meta) => {
        const purpose = mcpElicitationPurpose({
          mode,
          serverName,
          _meta,
          requestedSchema: props ? { type: "object", properties: props } : undefined,
        });
        const asksForFields = mode === "form" && props !== undefined && Object.keys(props).length > 0;
        const marked = _meta?.[ACP_AGENT_ELICITATION_META_KEY] === true;
        // Oracle: the marker only renames a form that asks for fields. It
        // never turns a link, confirmation, or tool approval into a question.
        expect(purpose === "agent-question").toBe(asksForFields && marked);
        if (mode === "url") expect(purpose).toBe("url");
        if (asksForFields && !marked) expect(purpose).toBe("form");
      },
    ));
  });
});
