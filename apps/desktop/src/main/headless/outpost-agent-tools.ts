import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";

/**
 * PwrAgent agent tools an untrusted model on the contained Outpost may call.
 *
 * A dynamic tool runs in the owner process, outside the Codex sandbox and
 * its network switch, with the owner's credentials and state. The Outpost
 * hosts research models it does not trust, so a tool is available there
 * only when it reads or writes nothing beyond the calling thread and sends
 * nothing off the machine. Every other tool is refused, including any tool
 * added later: this list is the whole grant.
 *
 * Allowed:
 * - `tool_search`, `read_tool_guide`: discovery over this filtered catalog
 *   and a static guide.
 * - Token Miser retrieval: reads output the calling thread's own commands
 *   produced; every handler scopes by the calling thread id.
 *
 * Refused, by family (the boot oracle lists every tool a booted Outpost
 * builds):
 * - Thread inspection, Attention, todos, reviews and automations read other
 *   threads' transcripts and the operator's queue.
 * - Thread orchestration, task monitors and thread mutation start, steer,
 *   stop or rewire other threads.
 * - Forge, messaging, federation and the MCP gateway send data off the
 *   machine with the owner's credentials.
 * - `manage_pwragent` restarts, stops or upgrades the owner.
 * - Star Map and focus tools drive or read an operator window.
 */
export const OUTPOST_AGENT_TOOL_ALLOWLIST: readonly string[] = Object.freeze([
  "tool_search",
  "read_tool_guide",
  "search_token_miser_output",
  "read_token_miser_output",
  "read_token_miser_output_batch",
  "read_all_token_miser_output",
].map((tool) => `${PWRAGENT_TOOL_NAMESPACE}/${tool}`));

/**
 * `namespace/tool`, or the bare tool name for a tool outside any namespace.
 * A part containing `/` qualifies to nothing, so a bare tool named
 * `pwragent/x` can never pass for the namespaced `x`.
 */
export function qualifiedAgentToolName(namespace: string | undefined, tool: string): string | undefined {
  if (tool.includes("/") || namespace?.includes("/")) return undefined;
  return namespace ? `${namespace}/${tool}` : tool;
}

function listed(allowlist: readonly string[], namespace: string | undefined, tool: string): boolean {
  const name = qualifiedAgentToolName(namespace, tool);
  return name !== undefined && allowlist.includes(name);
}

/**
 * Whether a model's `item/tool/call` names an allowed tool. Codex sends a
 * null namespace for PwrAgent tools on older runtimes, and the owner routes
 * those to the PwrAgent namespace, so this check does the same.
 */
export function isAgentToolCallAllowed(
  allowlist: readonly string[],
  call: { namespace?: unknown; tool?: unknown },
): boolean {
  if (typeof call.tool !== "string" || !call.tool) return false;
  const namespace = typeof call.namespace === "string"
    ? call.namespace
    : call.namespace === null ? PWRAGENT_TOOL_NAMESPACE : undefined;
  return listed(allowlist, namespace, call.tool);
}

type DynamicToolSpecLike = { type?: unknown; name?: unknown; tools?: unknown };

/** The number of tools in a spec list, counting each tool inside a namespace. */
export function countAgentTools(specs: readonly unknown[]): number {
  return specs.reduce<number>((count, spec) => {
    const value = spec as DynamicToolSpecLike | null;
    return count + (value?.type === "namespace" && Array.isArray(value.tools) ? value.tools.length : 1);
  }, 0);
}

/** Removes every advertised tool the allowlist does not name, and empty namespaces. */
export function filterAdvertisedAgentTools<T>(allowlist: readonly string[], specs: readonly T[]): T[] {
  return specs.flatMap((spec): T[] => {
    if (!spec || typeof spec !== "object") return [];
    const candidate = spec as DynamicToolSpecLike;
    if (typeof candidate.name !== "string") return [];
    if (candidate.type !== "namespace") {
      return listed(allowlist, undefined, candidate.name) ? [spec] : [];
    }
    const namespace = candidate.name;
    const tools = (Array.isArray(candidate.tools) ? candidate.tools : []).filter((tool: unknown) =>
      !!tool && typeof tool === "object" && typeof (tool as { name?: unknown }).name === "string"
      && listed(allowlist, namespace, (tool as { name: string }).name));
    return tools.length > 0 ? [{ ...spec, tools }] : [];
  });
}

/**
 * Outbound JSON-RPC rewriter for an Outpost Codex client: any request that
 * carries `dynamicTools` (thread start, resume, fork, a tool refresh, a
 * voice thread) reaches Codex with only the allowed tools. Every
 * advertisement path funnels through the transport, so a new call site
 * cannot skip the filter.
 */
export function createOutpostAgentToolMessageRewriter(allowlist: readonly string[]): (raw: string) => string {
  return (raw) => {
    // Most outbound messages carry no tool list; skip parsing those.
    if (!raw.includes("\"dynamicTools\"")) return raw;
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { return raw; }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return raw;
    const message = envelope as { method?: unknown; params?: unknown };
    if (typeof message.method !== "string" || !message.params || typeof message.params !== "object") return raw;
    const params = message.params as Record<string, unknown>;
    if (!Object.hasOwn(params, "dynamicTools") || params.dynamicTools === null || params.dynamicTools === undefined) return raw;
    params.dynamicTools = Array.isArray(params.dynamicTools)
      ? filterAdvertisedAgentTools(allowlist, params.dynamicTools)
      : [];
    return JSON.stringify(message);
  };
}
