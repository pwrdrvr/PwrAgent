import fs from "node:fs";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";

export type McpConnectionBrokerRecord = {
  version: 1;
  ownerInstanceId: string;
  socketPath: string;
  brokerToken: string;
  publishedAt: number;
};

export type McpConnectionBrokerDiscoveryOptions = {
  filePath?: string;
};

export class McpConnectionBrokerDiscovery {
  private readonly filePath: string;

  constructor(options: McpConnectionBrokerDiscoveryOptions = {}) {
    this.filePath = options.filePath
      ?? resolveActiveProfilePath("state/mcp-connection-broker.json");
  }

  read(): McpConnectionBrokerRecord | undefined {
    if (!fs.existsSync(this.filePath)) return undefined;
    if (process.platform !== "win32") {
      const mode = fs.statSync(this.filePath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(
          "The MCP connection broker discovery record has unsafe permissions.",
        );
      }
    }
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<McpConnectionBrokerRecord>;
      if (
        parsed.version !== 1
        || typeof parsed.ownerInstanceId !== "string"
        || !parsed.ownerInstanceId
        || typeof parsed.socketPath !== "string"
        || !parsed.socketPath
        || typeof parsed.brokerToken !== "string"
        || parsed.brokerToken.length < 32
        || typeof parsed.publishedAt !== "number"
      ) {
        throw new Error("invalid record");
      }
      return parsed as McpConnectionBrokerRecord;
    } catch (cause) {
      throw new Error("The MCP connection broker discovery record is invalid.", {
        cause,
      });
    }
  }

  publish(record: McpConnectionBrokerRecord): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(record), {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      fs.chmodSync(temporaryPath, 0o600);
    }
    fs.renameSync(temporaryPath, this.filePath);
  }

  clear(ownerInstanceId: string): void {
    const record = this.read();
    if (!record || record.ownerInstanceId !== ownerInstanceId) return;
    fs.unlinkSync(this.filePath);
  }
}
