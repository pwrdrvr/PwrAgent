/** Attribute the existing invocation; never synthesize a second tool event.
 * These are the requested source IDs, including when execution was denied.
 * The result's authenticated source additionally records the approved revision.
 */
export function gatewayInvocationName(name: string, input: unknown): string | undefined {
  let value = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  let args = value as Record<string, unknown>;
  if (name === "pwragent" && args.tool === "call_mcp_tool") {
    name = "call_mcp_tool";
    if (args.connectionId === undefined && args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)) {
      args = args.arguments as Record<string, unknown>;
    }
  }
  if (!["call_mcp_tool", "pwragent__call_mcp_tool", "pwragent.call_mcp_tool"].includes(name)) return undefined;
  if (typeof args.connectionId !== "string" || typeof args.toolName !== "string") return undefined;
  // JSON pairs preserve original names without normalization collisions.
  return `mcp:${JSON.stringify([args.connectionId, args.toolName])}`;
}
