import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpConnectionRegistry,
  normalizeMcpServerUrl,
} from "../mcp-connections/mcp-connection-registry";

const temporaryDirectories: string[] = [];

function configPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-registry-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "config.toml");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("McpConnectionRegistry", () => {
  it("preserves unrelated TOML while adding and removing a connection", () => {
    const target = configPath();
    fs.writeFileSync(target, [
      "# operator comment",
      "[general]",
      "theme = \"dark\"",
      "",
    ].join("\n"));
    const registry = new McpConnectionRegistry({
      configPath: target,
      now: () => 1_723_456_789_000,
    });

    const created = registry.create({
      displayName: "Atlassian Rovo",
      serverUrl: "https://mcp.atlassian.com/v1/mcp",
    });

    expect(created.id).toBe("atlassian-rovo");
    expect(registry.list()).toMatchObject([
      { id: "pwrsnap", kind: "pwrsnap" },
      {
        id: "atlassian-rovo",
        kind: "remote",
        serverUrl: "https://mcp.atlassian.com/v1/mcp",
      },
    ]);
    expect(fs.readFileSync(target, "utf8")).toContain("# operator comment");

    expect(registry.remove(created.id)).toBe(true);
    expect(registry.list().map((connection) => connection.id)).toEqual([
      "pwrsnap",
    ]);
    expect(fs.readFileSync(target, "utf8")).toContain("theme = \"dark\"");
  });

  it("accepts HTTPS and loopback HTTP but rejects unsafe remote URLs", () => {
    expect(normalizeMcpServerUrl("https://example.com/mcp"))
      .toBe("https://example.com/mcp");
    expect(normalizeMcpServerUrl("http://127.0.0.1:3000/mcp"))
      .toBe("http://127.0.0.1:3000/mcp");
    expect(() => normalizeMcpServerUrl("http://example.com/mcp"))
      .toThrow("must use HTTPS");
    expect(() => normalizeMcpServerUrl("https://user:secret@example.com/mcp"))
      .toThrow("cannot contain credentials");
    expect(() => normalizeMcpServerUrl("https://example.com/mcp#token"))
      .toThrow("cannot contain fragments");
  });
});
