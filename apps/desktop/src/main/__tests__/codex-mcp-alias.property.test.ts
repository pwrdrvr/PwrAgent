import fc from "fast-check";
import { expect, it } from "vitest";
import { formatToolIdentifier } from "../../shared/tool-activity";
import { buildCodexConnectionMcpServerName } from "../app-server/codex-thread-config";

it("preserves the connection ID through Codex namespace normalization and activity formatting", () => {
  const connectionId = fc.stringMatching(/^[a-z][a-z0-9_-]{0,63}$/);
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
    expect(formatToolIdentifier(alias, "probe")).toBe(`${name}/probe`);
  }));
});
