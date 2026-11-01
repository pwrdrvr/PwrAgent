import { describe, expect, it } from "vitest";
import { isMcpIpcUrl, parseMcpIpcUrl } from "../mcp-ipc-url";

describe("HTTP IPC URLs", () => {
  it("keeps the decoded endpoint separate from the escaped HTTP target", () => {
    expect(parseMcpIpcUrl("unix:///Users/Example/Private%20MCP/server%2520.sock#/mcp/a%2Fb?q=%23%26&x=1")).toEqual({
      scheme: "unix", path: "/Users/Example/Private MCP/server%20.sock",
      requestTarget: "/mcp/a%2Fb?q=%23%26&x=1",
      url: "unix:///Users/Example/Private%20MCP/server%2520.sock#/mcp/a%2Fb?q=%23%26&x=1",
    });
    expect(parseMcpIpcUrl("unix:///tmp/server.sock").requestTarget).toBe("/");
    expect(parseMcpIpcUrl("pipe:///pipe/example-name#/mcp?x=a%20b").path).toBe("\\\\.\\pipe\\example-name");
    expect(isMcpIpcUrl("https://example.com")).toBe(false);
  });

  it.each([
    "unix://host/tmp/a.sock", "unix:/tmp/a.sock", "UNIX:///tmp/a.sock",
    "unix:///tmp/a.sock?query=ambiguous", "unix:///tmp/a.sock#",
    "unix:///tmp/a.sock#https://host/mcp", "unix:///tmp/a.sock#//host/mcp",
    "unix:///tmp/a.sock#/a/../mcp", "unix:///tmp/a.sock#/%2e%2e/mcp",
    "unix:///tmp/a.sock#/mcp#fragment", "unix:///tmp/a.sock#/mcp%xx",
    "unix:///tmp/a.sock#/%0d%0a", "unix:///tmp/%2fa.sock",
    "unix:///tmp/%5ca.sock", "unix:///tmp/%00a.sock", "unix:///tmp/%zz",
    "unix:///tmp//a.sock", "unix:///tmp/../a.sock", "unix:///tmp/./a.sock",
    "unix:///tmp/a.sock/", "unix://user:secret@/tmp/a.sock",
    "pipe://server/pipe/name", "pipe:////server/pipe/name", "pipe:///pipe/name/nested",
    "pipe:///pipe/..", "pipe:///pipe/name:stream", "pipe:///pipe/name%5cother",
  ])("rejects malformed or ambiguous %s", (url) => {
    expect(() => parseMcpIpcUrl(url)).toThrow();
  });
});
