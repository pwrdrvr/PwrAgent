import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type ExecutableAcpMarker = {
  argv: string[];
  executable: string;
  id: string;
  kind: "acp" | "disposed" | "probe";
  version: string;
};

export type ExecutableAcpProviderFixture = {
  defaultCommand: string;
  markerPath: string;
  overrideCommand: string;
  readMarkers: () => ExecutableAcpMarker[];
};

export function createExecutableAcpProviderFixture(params: {
  rootDir: string;
  registryId: "gemini" | "grok" | "kimi" | "qwen";
  suffix?: string;
}): ExecutableAcpProviderFixture {
  const suffix = params.suffix ? `-${params.suffix}` : "";
  const defaultDir = path.join(params.rootDir, `path-bin${suffix}`);
  const overrideDir = path.join(params.rootDir, `override-bin${suffix}`);
  const markerPath = path.join(
    params.rootDir,
    `${params.registryId}${suffix}-invocations.jsonl`,
  );
  const defaultCommand = path.join(defaultDir, params.registryId);
  const overrideCommand = path.join(
    overrideDir,
    `${params.registryId}-absolute-override`,
  );
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  writeExecutable({
    command: defaultCommand,
    id: `${params.registryId}-default${suffix}`,
    markerPath,
    registryId: params.registryId,
    version: "0.1.0-default",
  });
  writeExecutable({
    command: overrideCommand,
    id: `${params.registryId}-override${suffix}`,
    markerPath,
    registryId: params.registryId,
    version: "0.2.0-override",
  });

  return {
    defaultCommand,
    markerPath,
    overrideCommand,
    readMarkers: () => readMarkers(markerPath),
  };
}

function writeExecutable(params: {
  command: string;
  id: string;
  markerPath: string;
  registryId: "gemini" | "grok" | "kimi" | "qwen";
  version: string;
}): void {
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
const executable = ${JSON.stringify(params.command)};
const id = ${JSON.stringify(params.id)};
const markerPath = ${JSON.stringify(params.markerPath)};
const registryId = ${JSON.stringify(params.registryId)};
const version = ${JSON.stringify(params.version)};
const record = (kind) => {
  fs.appendFileSync(markerPath, JSON.stringify({
    argv,
    executable,
    id,
    kind,
    version,
  }) + "\\n");
};
if (argv.includes("--version")) {
  record("probe");
  process.stdout.write(
    registryId === "kimi"
      ? "kimi-code " + version + "\\n"
      : registryId + " " + version + "\\n",
  );
  process.exit(0);
}
if (argv.includes("--help")) {
  record("probe");
  const help = registryId === "grok"
    ? "Run the agent over stdio"
    : registryId === "qwen"
      ? "Qwen Code --acp"
      : registryId === "gemini"
        ? "Usage: gemini --acp"
        : "Agent Client Protocol server";
  process.stdout.write(help + "\\n");
  process.exit(0);
}
record("acp");
process.on("SIGTERM", () => {
  record("disposed");
  process.exit(0);
});
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result = request.method === "initialize"
    ? { protocolVersion: 1, agentCapabilities: {} }
    : request.method === "session/new"
      ? { sessionId: id + "-session" }
      : {};
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result,
  }) + "\\n");
});
`;
  writeFileSync(params.command, source, "utf8");
  chmodSync(params.command, 0o755);
}

function readMarkers(markerPath: string): ExecutableAcpMarker[] {
  try {
    return readFileSync(markerPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ExecutableAcpMarker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
