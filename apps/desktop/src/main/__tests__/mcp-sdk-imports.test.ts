import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const MAIN = path.resolve(import.meta.dirname, "..");

// The bridge runs in its own process, which needs the SDK at once.
const SEPARATE_PROCESS_ENTRIES = new Set(["mcp-connections/mcp-connection-bridge-entry.ts"]);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

/** Static import or re-export statements that bring in an SDK value. */
function sdkValueImports(source: string): string[] {
  const statements = source.matchAll(/^(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+"(@modelcontextprotocol\/sdk[^"]*)"/gm);
  return [...statements].flatMap(([statement, typeOnly, clause]) => {
    if (typeOnly) return [];
    const named = /^\{([\s\S]*)\}$/.exec(clause!.trim());
    const valueNames = named
      ? named[1]!.split(",").map((name) => name.trim()).filter((name) => name && !name.startsWith("type "))
      : [clause!.trim()];
    return valueNames.length > 0 ? [statement!.replace(/\s+/g, " ")] : [];
  });
}

// `isMcpError` and `loadedMcpTypes` answer from the lazy loaders' state. They
// are sound only while every owner path reaches the SDK through those
// loaders, and a static value import would also put the SDK back on every
// owner start.
it("owner code reaches MCP SDK values only through the lazy loaders in mcp-sdk.ts", () => {
  const violations = sourceFiles(MAIN).flatMap((file) => {
    const relative = path.relative(MAIN, file).split(path.sep).join("/");
    if (SEPARATE_PROCESS_ENTRIES.has(relative)) return [];
    return sdkValueImports(fs.readFileSync(file, "utf8")).map((statement) => `${relative}: ${statement}`);
  });
  expect(violations).toEqual([]);
});

it("recognizes a value import, and passes type-only ones", () => {
  expect(sdkValueImports(`import { McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";`)).toHaveLength(1);
  expect(sdkValueImports(`import { Client } from "@modelcontextprotocol/sdk/client/index.js";`)).toHaveLength(1);
  expect(sdkValueImports(`import type { Tool } from "@modelcontextprotocol/sdk/types.js";`)).toEqual([]);
  expect(sdkValueImports(`import { type Tool, type Root } from "@modelcontextprotocol/sdk/types.js";`)).toEqual([]);
  expect(sdkValueImports(`export type { Tool } from "@modelcontextprotocol/sdk/types.js";`)).toEqual([]);
});
