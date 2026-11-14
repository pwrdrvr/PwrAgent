/**
 * Which upstream MCP server capabilities a thread's native bridge relays.
 *
 * The bridge is an allowlist: it declares only what it relays and handles
 * only methods it knows, so a capability it does not relay never fails. It
 * simply never reaches the agent. That is how the skills extension went
 * unrelayed until GitHub's server shipped it (#3707): every check passed
 * because nothing checked.
 *
 * So every capability is listed here, relayed or not, with the reason.
 * `mcp-bridge-capabilities.test.ts` fails when the SDK knows a capability
 * this table does not, and checks the bridge declares exactly the relayed
 * ones. At run time, `unrelayedMcpCapabilities` names what a real server
 * advertised that threads will not see, including extensions nobody has
 * classified yet.
 *
 * Nothing here runs at import: the bridge entry imports this module too.
 */
import { MCP_SKILLS_EXTENSION } from "./mcp-skills-relay";

export type BridgeCapabilityPolicy =
  | { relayed: true }
  | { relayed: false; reason: string };

export const BRIDGE_CAPABILITIES = {
  tools: { relayed: true },
  resources: { relayed: true },
  prompts: { relayed: true },
  // Each extension is classified on its own, in RELAYED_MCP_EXTENSIONS.
  extensions: { relayed: true },
  logging: { relayed: false, reason: "The bridge does not handle logging/setLevel or forward log messages." },
  completions: { relayed: false, reason: "The bridge does not handle completion/complete." },
  tasks: { relayed: false, reason: "The bridge does not handle task-augmented requests." },
  experimental: { relayed: false, reason: "Non-standard capabilities have no agreed methods to relay." },
} as const satisfies Record<string, BridgeCapabilityPolicy>;

/** Extensions the bridge declares and serves when the upstream server does. */
export const RELAYED_MCP_EXTENSIONS: readonly string[] = [MCP_SKILLS_EXTENSION];

/**
 * What a server advertised that a thread's agent will not see:
 * `completions`, or `extensions:<id>` for an extension. Sorted, so the same
 * server always names the same list.
 */
export function unrelayedMcpCapabilities(capabilities: Record<string, unknown> | undefined): string[] {
  if (!capabilities) return [];
  const unrelayed: string[] = [];
  for (const [name, value] of Object.entries(capabilities)) {
    if (value === undefined || value === null) continue;
    const policy = (BRIDGE_CAPABILITIES as Record<string, BridgeCapabilityPolicy>)[name];
    if (!policy || !policy.relayed) {
      unrelayed.push(name);
      continue;
    }
    if (name === "extensions" && typeof value === "object") {
      for (const [id, declared] of Object.entries(value as Record<string, unknown>)) {
        if (declared !== undefined && declared !== null && !RELAYED_MCP_EXTENSIONS.includes(id)) {
          unrelayed.push(`extensions:${id}`);
        }
      }
    }
  }
  return unrelayed.sort();
}
