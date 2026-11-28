import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import type { BoundedCommandCapture, BoundedCommandReceipt } from "../token-miser/bounded-command";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { serializeToolResponse } from "../token-miser/token-miser-types";
import { agentToolFailure, agentToolSuccess, type AgentToolCallContext, type AgentToolDefinition } from "./agent-tool-definition";

export function boundedCommandTools(capture?: BoundedCommandCapture, store?: TokenMiserStore): AgentToolDefinition[] {
  if (!capture || process.platform === "win32") return [];
  const delivered = async (context: AgentToolCallContext, result: unknown, receipt?: BoundedCommandReceipt) => {
    const text = serializeToolResponse(result);
    const codex = context.backend === "codex";
    const delivery = store && codex && context.turnId
      ? await store.prepareOwnerTextDelivery({
        threadId: context.threadId, turnId: context.turnId, visibleText: text, allowJsonString: true, capture: receipt,
      })
      : undefined;
    if (!codex && receipt && !context.signal?.aborted) {
      const confirm = () => capture.confirmDelivery({ ...receipt, deliveredBytes: Buffer.byteLength(text) });
      if (context.responseFlushed) void context.responseFlushed.then(confirm).catch(() => {});
      else confirm();
    }
    // Stock Codex has no outer-result receipt. Leave its response shape intact.
    if (!delivery && typeof result !== "string") return agentToolSuccess(result);
    const visibleText = delivery?.text ?? text;
    return agentToolSuccess(result, { contentItems: [{ type: "inputText", text: visibleText }],
      mcpContentItems: [{ type: "text", text: visibleText }] });
  };
  return [{
    namespace: PWRAGENT_TOOL_NAMESPACE,
    name: "capture_token_miser_command",
    description: "Opt in to bounded output for one foreground git diff, git diff --cached, node --test FILE.test.cjs/js/mjs, or pnpm exec vitest run FILE.test.ts/tsx. Pass command, then run the returned command verbatim through your native POSIX shell in the intended directory with ordinary permissions. After it exits, call this tool with just objectId for the failure block or diff summary. In native Code Mode, keep the prepared command inside the cell, await execution and inspection in order, and emit the returned summary string directly with its objectId. If the sandbox refuses the capture, use ordinary bounded commands within its permissions. To retrieve, pass only objectId and optional inclusive startLine/endLine or literal query. Pass byteOffset for a lossless 1024-byte base64 page. Objects last up to five minutes within this turn.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        command: { type: "string" }, objectId: { type: "string" }, query: { type: "string" },
        byteOffset: { type: "integer", minimum: 0 },
        startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
      },
    },
    dispatch: async (args, context) => {
      try {
        if (typeof args.command === "string" && Object.keys(args).length === 1) {
          return agentToolSuccess(await capture.prepare(context, args.command, context.signal));
        }
        if (typeof args.objectId === "string") {
          const keys = Object.keys(args);
          let receipt: BoundedCommandReceipt | undefined;
          const receive = (value: BoundedCommandReceipt) => { receipt = value; };
          if (keys.length === 2 && typeof args.byteOffset === "number") {
            const page = await capture.readBytes(context, args.objectId, args.byteOffset, receive);
            return await delivered(context, page, receipt);
          }
          if (keys.every((key) => ["objectId", "query", "startLine", "endLine"].includes(key))
            && (args.query === undefined || typeof args.query === "string")
            && (args.startLine === undefined || typeof args.startLine === "number")
            && (args.endLine === undefined || typeof args.endLine === "number")) {
            const start = args.startLine ?? 1;
            const text = await capture.inspect(context, args.objectId, keys.length === 1 ? undefined : {
              start, end: args.endLine ?? (args.query === undefined ? start + 19 : undefined), query: args.query,
            }, receive);
            return await delivered(context, text, receipt);
          }
        }
        return agentToolFailure({ code: "invalid_arguments", message: "Supply a command or an output reference." });
      } catch (error) {
        return agentToolFailure({ code: "capture_unavailable", message: error instanceof Error ? error.message : "Capture unavailable." });
      }
    },
  }];
}
