import path from "node:path";

/** Packages a headless owner loads on first use, never at start. Each one
 * cost 25-70 ms of cold loading on every owner start when it was static.
 * zod and ajv arrive only with the MCP SDK and MCP schema validation. The
 * ACP SDK stays out because the owner imports agent-acp's strategies,
 * discovery and MCP config helpers from their SDK-free subpaths. */
export const LOADED_ON_FIRST_USE = [
  "sigstore",
  "@anthropic-ai/claude-agent-sdk",
  "@napi-rs/canvas",
  "@modelcontextprotocol/sdk",
  "zod",
  "ajv",
  "@agentclientprotocol/sdk",
];

/** The npm package that owns a loaded file, or undefined outside node_modules. */
export function packageOfFile(file: string): string | undefined {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0) return undefined;
  return parts[at + 1]!.startsWith("@") ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
}
