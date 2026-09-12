import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  McpConnectionBrokerDiscovery,
} from "../mcp-connections/mcp-connection-broker-discovery";

const temporaryDirectories: string[] = [];

function discoveryPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-broker-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "broker.json");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("McpConnectionBrokerDiscovery", () => {
  it("publishes an owner-only authenticated discovery record", () => {
    const filePath = discoveryPath();
    const discovery = new McpConnectionBrokerDiscovery({ filePath });
    discovery.publish({
      version: 1,
      ownerInstanceId: "instance-a",
      socketPath: "/tmp/pwragent-mcp.sock",
      brokerToken: "a".repeat(43),
      publishedAt: 1_723_456_789_000,
    });

    expect(discovery.read()).toMatchObject({
      ownerInstanceId: "instance-a",
      socketPath: "/tmp/pwragent-mcp.sock",
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it("clears only the record published by the same owner", () => {
    const filePath = discoveryPath();
    const discovery = new McpConnectionBrokerDiscovery({ filePath });
    discovery.publish({
      version: 1,
      ownerInstanceId: "instance-a",
      socketPath: "/tmp/pwragent-mcp.sock",
      brokerToken: "b".repeat(43),
      publishedAt: 1,
    });

    discovery.clear("instance-b");
    expect(discovery.read()).toBeDefined();
    discovery.clear("instance-a");
    expect(discovery.read()).toBeUndefined();
  });
});
