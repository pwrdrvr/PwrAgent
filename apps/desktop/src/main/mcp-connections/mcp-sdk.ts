import type { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpError } from "@modelcontextprotocol/sdk/types.js";
import { lazyModule, type LazyModule } from "../lazy-module";

/**
 * The MCP SDK, loaded on first use. Every SDK entry point evaluates
 * `types.js`, whose zod schemas cost ~50 ms of cold loading, and an owner
 * that has no MCP session open needs none of it: the agent-tool server and
 * the connection gateway's bridge both listen without it.
 *
 * Owner code reaches SDK values only through these loaders. A static value
 * import anywhere in the owner graph would put the whole SDK back on every
 * start, and `mcp-sdk-imports.test.ts` fails when one appears.
 */
export const mcpTypes = lazyModule(() => import("@modelcontextprotocol/sdk/types.js"));

// Each loader finishes `mcpTypes` first, so no SDK code can construct an
// `McpError` while `mcpTypes.loaded()` still reports undefined.
function sdkModule<T>(importModule: () => Promise<T>): LazyModule<T> {
  return lazyModule(async () => {
    await mcpTypes.load();
    return await importModule();
  });
}

export const mcpClient = sdkModule(() => import("@modelcontextprotocol/sdk/client/index.js"));
export const mcpClientAuth = sdkModule(() => import("@modelcontextprotocol/sdk/client/auth.js"));
export const mcpClientStdio = sdkModule(() => import("@modelcontextprotocol/sdk/client/stdio.js"));
export const mcpClientStreamableHttp = sdkModule(() => import("@modelcontextprotocol/sdk/client/streamableHttp.js"));
export const mcpSharedStdio = sdkModule(() => import("@modelcontextprotocol/sdk/shared/stdio.js"));
export const mcpServer = sdkModule(() => import("@modelcontextprotocol/sdk/server/index.js"));
export const mcpServerStreamableHttp = sdkModule(() => import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"));

/**
 * The SDK's types for code that runs only on a message an SDK session
 * carried, so a loader has already finished. Throws when none has.
 */
export function loadedMcpTypes(): typeof import("@modelcontextprotocol/sdk/types.js") {
  const types = mcpTypes.loaded();
  if (!types) throw new Error("The MCP SDK has not loaded.");
  return types;
}

/**
 * Whether `error` is an SDK `McpError`. No such error can exist before the
 * SDK has loaded, so an unloaded SDK answers false without loading it.
 */
export function isMcpError(error: unknown): error is McpError {
  const types = mcpTypes.loaded();
  return types !== undefined && error instanceof types.McpError;
}

/** Whether `error` came from the SDK's Streamable HTTP client transport. */
export function isStreamableHttpError(error: unknown): error is StreamableHTTPError {
  const transport = mcpClientStreamableHttp.loaded();
  return transport !== undefined && error instanceof transport.StreamableHTTPError;
}
