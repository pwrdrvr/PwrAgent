import { ServerCapabilitiesSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  BRIDGE_CAPABILITIES,
  RELAYED_MCP_EXTENSIONS,
  unrelayedMcpCapabilities,
} from "../mcp-connections/mcp-bridge-capabilities";

/*
 * The bridge relays a capability only when someone wrote the code to. These
 * tests make that a decision: an SDK upgrade that adds a capability fails
 * here until it is classified, as relayed or not with a reason.
 * mcp-connection-bridge-entry.test.ts checks the bridge declares what this
 * table says.
 */
describe("bridge capability table", () => {
  it("classifies every capability the MCP SDK knows, and nothing else", () => {
    expect(Object.keys(BRIDGE_CAPABILITIES).sort()).toEqual(Object.keys(ServerCapabilitiesSchema.shape).sort());
  });

  it("gives a reason for each capability it does not relay", () => {
    for (const policy of Object.values(BRIDGE_CAPABILITIES)) {
      if (!policy.relayed) expect(policy.reason.trim()).not.toBe("");
    }
  });

  it("names unrelayed capabilities and unclassified extensions, sorted", () => {
    expect(unrelayedMcpCapabilities({
      tools: {},
      completions: {},
      logging: {},
      extensions: { [RELAYED_MCP_EXTENSIONS[0]!]: {}, "com.example/future": {} },
      "io.example/unknown-top-level": {},
    })).toEqual(["completions", "extensions:com.example/future", "io.example/unknown-top-level", "logging"]);
    expect(unrelayedMcpCapabilities({ tools: {}, resources: { subscribe: true }, prompts: {} })).toEqual([]);
    expect(unrelayedMcpCapabilities(undefined)).toEqual([]);
  });
});
