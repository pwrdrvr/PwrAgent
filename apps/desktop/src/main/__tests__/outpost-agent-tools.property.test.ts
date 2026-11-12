import fc from "fast-check";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { withPwrAgentToolDiscovery } from "../agent-tools/pwragent-tool-search";
import { buildCodexParentDynamicToolSpecs } from "../app-server/codex-thread-config";
import {
  OUTPOST_AGENT_TOOL_ALLOWLIST,
  createOutpostAgentToolMessageRewriter,
  isAgentToolCallAllowed,
  qualifiedAgentToolName,
} from "../headless/outpost-agent-tools";
import { agentToolAllowlistForRole } from "../member-containment";

// Rule: an untrusted model on a contained member sees and can call only the
// agent tools the allowlist names. A dynamic tool runs in the owner, outside
// the Codex sandbox, so the allowlist is the whole grant: a tool added to any
// catalog later is refused until someone lists it.

const stub = (async () => ({})) as never;
/** Every catalog with every handler wired, as the owner services wire them. */
function fullCatalog() {
  return withPwrAgentToolDiscovery(buildCodexParentDynamicToolSpecs(resolveAgentToolCatalogs({
    appManagementHandler: stub, automationInspectionHandler: stub, federationHandler: stub,
    mcpConnectionHandler: stub, mcpGatewayTools: {} as never, messagingHandler: stub,
    taskMonitorHandler: stub, threadInspectionHandler: stub, forgeReadHandler: stub,
    forgePrToolHandler: stub, threadOrchestrationHandler: stub, tokenMiserStore: {} as never,
    starMapHandler: stub, threadTodoHandler: stub,
  }, { taskMonitorRole: "all" })), true);
}
function names(specs: readonly unknown[]): string[] {
  return specs.flatMap((spec) => {
    const value = spec as { type?: string; name: string; tools?: Array<{ name: string }> };
    return value.type === "namespace"
      ? (value.tools ?? []).flatMap((tool) => qualifiedAgentToolName(value.name, tool.name) ?? [])
      : qualifiedAgentToolName(undefined, value.name) ?? [];
  });
}

const catalogNames = names(fullCatalog());
const allowlist = agentToolAllowlistForRole("contained")!;
const toolName = fc.oneof(fc.constantFrom(...catalogNames.map((name) => name.split("/").at(-1)!)), fc.string({ minLength: 1 }));
const namespaceName = fc.oneof(fc.constant(PWRAGENT_TOOL_NAMESPACE), fc.string({ minLength: 1 }));

describe("Outpost agent tool allowlist", () => {
  it("is the grant every contained member runs, and names only tools the catalogs define", () => {
    expect(allowlist).toEqual(OUTPOST_AGENT_TOOL_ALLOWLIST);
    // A renamed tool would otherwise silently drop out of the grant.
    for (const name of allowlist) expect(catalogNames).toContain(name);
    // The catalog is much larger than the grant; keep the probe honest.
    expect(catalogNames.length).toBeGreaterThan(allowlist.length * 5);
  });

  it("advertises exactly the allowed subset of any tool list, on every outbound request", () => {
    const rewrite = createOutpostAgentToolMessageRewriter(() => allowlist);
    const flatTool = fc.record({ type: fc.constant("function"), name: toolName, description: fc.string() });
    const namespaceTool = fc.record({
      type: fc.constant("namespace"), name: namespaceName, description: fc.string(),
      tools: fc.array(fc.record({ name: toolName, description: fc.string() }), { maxLength: 8 }),
    });
    fc.assert(fc.property(
      fc.constantFrom("thread/start", "thread/resume", "thread/fork", "thread/dynamicTools/update", "turn/start"),
      fc.array(fc.oneof(flatTool, namespaceTool), { maxLength: 6 }),
      fc.boolean(),
      (method, generated, includeCatalog) => {
        const input = includeCatalog ? [...fullCatalog(), ...generated] : generated;
        const sent = JSON.parse(rewrite(JSON.stringify({ id: 1, method, params: { threadId: "t", dynamicTools: input } })));
        const advertised = names(sent.params.dynamicTools);
        for (const name of advertised) expect(allowlist).toContain(name);
        expect(new Set(advertised)).toEqual(new Set(names(input).filter((name) => allowlist.includes(name))));
        for (const spec of sent.params.dynamicTools) if (spec.type === "namespace") expect(spec.tools.length).toBeGreaterThan(0);
      },
    ));
  });

  it("strips the whole Outpost catalog down to the grant", () => {
    const rewrite = createOutpostAgentToolMessageRewriter(() => allowlist);
    const sent = JSON.parse(rewrite(JSON.stringify({ id: 1, method: "thread/start", params: { dynamicTools: fullCatalog() } })));
    expect(new Set(names(sent.params.dynamicTools))).toEqual(new Set(allowlist));
  });

  it("allows a call only when its qualified name is listed, whatever the model sends", () => {
    fc.assert(fc.property(fc.oneof(namespaceName, fc.constant(null), fc.constant(undefined), fc.integer()), fc.oneof(toolName, fc.constant(undefined)), (namespace, tool) => {
      const effective = namespace === null ? PWRAGENT_TOOL_NAMESPACE : typeof namespace === "string" ? namespace : undefined;
      const name = typeof tool === "string" && tool.length > 0 ? qualifiedAgentToolName(effective, tool) : undefined;
      const expected = name !== undefined && allowlist.includes(name);
      expect(isAgentToolCallAllowed(allowlist, { namespace, tool })).toBe(expected);
    }));
    for (const name of catalogNames) {
      const [namespace, tool] = name.split("/");
      expect(isAgentToolCallAllowed(allowlist, { namespace, tool })).toBe(allowlist.includes(name));
    }
  });
});
