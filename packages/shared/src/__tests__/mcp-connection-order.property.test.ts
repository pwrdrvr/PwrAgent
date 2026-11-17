import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { McpConnectionKind, McpConnectionStatus } from "../contracts/mcp-connections";
import {
  groupManagedMcpConnections,
  isSuggestedMcpConnection,
  orderManagedMcpConnections,
} from "../mcp-connection-order";

const KINDS: McpConnectionKind[] = ["remote", "pwrsnap", "pwrgit", "sandboxer", "stdio", "github"];

function connection(kind: McpConnectionKind, index: number): McpConnectionStatus {
  return {
    id: `${kind}-${index}`,
    displayName: `${kind} ${index}`,
    serverUrl: `${kind}:${index}`,
    kind,
    authMode: "none",
    enabled: true,
    configured: true,
    state: "ready",
    createdAt: index,
    updatedAt: index,
  };
}

const connectionLists = fc
  .array(fc.constantFrom(...KINDS), { maxLength: 24 })
  .map((kinds) => kinds.map(connection));

/**
 * The oracle: PwrSnap and PwrGit first, then every GitHub connection as one
 * group, then everything else, each group in the order the registry listed it.
 */
function oracle(connections: McpConnectionStatus[]): string[] {
  const rank = (kind: McpConnectionKind) =>
    kind === "pwrsnap" || kind === "pwrgit" ? 0 : kind === "github" ? 1 : 2;
  return connections
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.kind) - rank(b.item.kind) || a.index - b.index)
    .map(({ item }) => item.id);
}

describe("managed MCP connection order properties", () => {
  it("lists PwrSuite, then GitHub, then the rest, keeping registry order within each", () => {
    fc.assert(fc.property(connectionLists, (connections) => {
      const groups = groupManagedMcpConnections(connections);
      const drawn = [...groups.pwrSuite, ...groups.github, ...groups.rest].map((item) => item.id);
      expect(drawn).toEqual(oracle(connections));
      expect(groups.github.every((item) => item.kind === "github")).toBe(true);
      expect(groups.rest.some((item) => item.kind === "github" || item.kind === "pwrsnap" || item.kind === "pwrgit"))
        .toBe(false);
      expect(orderManagedMcpConnections(connections).map((item) => item.id)).toEqual(drawn);
    }));
  });

  // Settings lists a connection under Suggested only when it is a built-in
  // PwrAgent can set up (PwrSnap, PwrGit, Sandboxer) that does not work yet.
  // Anything the operator added is installed, working or not.
  it("suggests only built-ins that are not set up", () => {
    fc.assert(fc.property(fc.constantFrom(...KINDS), fc.boolean(), (kind, configured) => {
      const builtIn = kind === "pwrsnap" || kind === "pwrgit" || kind === "sandboxer";
      expect(isSuggestedMcpConnection({ ...connection(kind, 0), configured }))
        .toBe(builtIn && !configured);
    }));
  });

  it("splits a list into installed and suggested without losing or reordering any", () => {
    const lists = fc.array(fc.tuple(fc.constantFrom(...KINDS), fc.boolean()), { maxLength: 24 })
      .map((entries) => entries.map(([kind, configured], index) => ({ ...connection(kind, index), configured })));
    fc.assert(fc.property(lists, (connections) => {
      const ordered = orderManagedMcpConnections(connections);
      const installed = ordered.filter((item) => !isSuggestedMcpConnection(item));
      const suggested = ordered.filter(isSuggestedMcpConnection);
      expect([...installed, ...suggested].map((item) => item.id).sort())
        .toEqual(connections.map((item) => item.id).sort());
      expect(installed.map((item) => item.id)).toEqual(oracle(installed));
      expect(suggested.map((item) => item.id)).toEqual(oracle(suggested));
    }));
  });

  it("puts a GitHub connection created before a remote one after PwrGit and before it", () => {
    const groups = groupManagedMcpConnections([
      connection("remote", 0),
      connection("github", 1),
      connection("pwrgit", 2),
      connection("sandboxer", 3),
    ]);
    expect([...groups.pwrSuite, ...groups.github, ...groups.rest].map((item) => item.id))
      .toEqual(["pwrgit-2", "github-1", "remote-0", "sandboxer-3"]);
  });
});
