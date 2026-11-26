import fc from "fast-check";
import { expect, it } from "vitest";
import { buildCodexConnectionMcpServerName } from "../app-server/codex-thread-config";

it("keeps managed Codex server names unchanged by tool namespace normalization", () => {
  const connectionId = fc.stringMatching(/^[a-z][a-z0-9]{0,9}(-[a-z0-9]{1,10}){0,3}$/);
  fc.assert(fc.property(connectionId, (name) => {
    const alias = buildCodexConnectionMcpServerName({
      name,
      command: "fixture",
      args: [],
      env: { PWRAGENT_MCP_CONNECTION_NAME: name },
    });
    // The tool namespace replaces hyphens, while resource RPCs look up the
    // exact configured server name. A managed name must round-trip unchanged.
    expect(alias.replaceAll("-", "_")).toBe(alias);
  }));
});
