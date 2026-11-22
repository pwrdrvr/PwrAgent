import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { query, type Options, type SDKControlRequest, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import { expect, it } from "vitest";
import { ClaudeBackend } from "../claude/claude-backend";
import { inspectClaudeInstallation } from "../claude/claude-executable";
import { ClaudeSessionStore } from "../claude/claude-session-store";

type Delivery = "initialize" | "mcp_set_servers";
type Fixture = {
  systemVersion?: string;
  bundled?: boolean;
  delivery: Delivery;
  reject?: boolean;
  strict?: boolean;
};

async function observeLaunch(fixture: Fixture, marker: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-mcp-delivery-"));
  const mcpServers = {
    remote: { type: "http", url: "https://mcp.invalid/fixture", headers: { Authorization: `Bearer ${marker}` } },
    helper: { type: "stdio", command: "fixture-helper", env: { TOKEN: marker } },
  } satisfies Options["mcpServers"];
  const system = path.join(root, "system", "claude");
  const bundled = path.join(root, "bundle", "claude");
  const commands: SDKControlRequest["request"][] = [];
  const seen = Promise.withResolvers<"prompt" | "failed">();
  const stopped = Promise.withResolvers<void>();
  let launch: SpawnOptions | undefined;
  let stopFixture: (() => void) | undefined;
  let promptCount = 0;
  let commandsBeforePrompt = 0;
  const backend = new ClaudeBackend({
    store: new ClaudeSessionStore(path.join(root, "sessions")),
    resolveEnv: async () => ({}),
    discoverModels: async () => [],
    inspectInstallation: async () => await inspectClaudeInstallation({
      env: {},
      resolveExecutable: async () => fixture.systemVersion ? system : undefined,
      resolveBundledExecutable: async () => fixture.bundled ? bundled : undefined,
      readVersion: async (file) => `${file === bundled ? "2.1.330" : fixture.systemVersion} (Claude Code)`,
      readAuthStatus: async () => JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    }),
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
    emit: async (event) => {
      if (event.notification.method === "turn/failed") seen.resolve("failed");
    },
    query: ({ prompt, options }) => query({ prompt, options: {
      ...options,
      spawnClaudeCodeProcess: (spawn) => {
        launch = spawn;
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const lines = createInterface({ input: stdin });
        const child = Object.assign(new EventEmitter(), {
          stdin, stdout, killed: false, exitCode: null,
          kill() {
            if (child.killed) return false;
            child.killed = true;
            lines.close();
            stdin.end();
            stdout.end();
            queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
            stopped.resolve();
            return true;
          },
        });
        stopFixture = () => { child.kill(); };
        lines.on("line", (line) => {
          const message = JSON.parse(line) as SDKControlRequest | { type: "user" };
          if (message.type === "user") {
            promptCount += 1;
            commandsBeforePrompt = commands.length;
            seen.resolve("prompt");
            return;
          }
          if (message.type !== "control_request") return;
          const request = message.request;
          commands.push(request);
          const reject = fixture.reject && request.subtype === fixture.delivery;
          const response = request.subtype === "initialize"
            ? { commands: [], models: [], mcp_servers_applied: Boolean(request.mcpServers) }
            : { added: Object.keys(mcpServers), removed: [], errors: {} };
          stdout.write(JSON.stringify({ type: "control_response", response: {
            request_id: message.request_id,
            ...(reject ? { subtype: "error", error: "fixture refused MCP configuration" } : { subtype: "success", response }),
          } }) + "\n");
        });
        return child;
      },
    } }),
  });
  try {
    const { threadId } = await backend.startThread({ cwd: root, executionMode: "default" });
    // Newer SDK queries may report initialization failure through the stream;
    // older CLI control failures can reject startTurn before consumption.
    const start = backend.startTurn({ threadId, mcpServers, strictMcpConfig: fixture.strict,
      input: [{ type: "text", text: "Fixture prompt" }],
    }).catch(() => seen.resolve("failed"));
    const outcome = await seen.promise;
    await start;
    if (fixture.reject && outcome === "failed") await stopped.promise;
    return { launch, commands, commandsBeforePrompt, outcome, promptCount, mcpServers, bundled, system };
  } finally {
    stopFixture?.();
    await backend.close();
    await rm(root, { recursive: true, force: true });
  }
}

const launches: Array<Fixture & { name: string }> = [
  { name: "the bundled CLI", bundled: true, systemVersion: "2.1.329", delivery: "initialize", strict: true },
  { name: "a newer system CLI", bundled: true, systemVersion: "2.1.340", delivery: "initialize" },
  { name: "an older system-only CLI", systemVersion: "2.1.250", delivery: "mcp_set_servers", strict: true },
  { name: "an unversioned system-only CLI", systemVersion: "unknown", delivery: "mcp_set_servers" },
];

it.each(launches)("sends MCP config over stdin before prompting $name", async (fixture) => {
  await fc.assert(fc.asyncProperty(fc.uuid(), async (id) => {
    const marker = `fixture-mcp-${id}`;
    const { launch, commands, commandsBeforePrompt, outcome, mcpServers, bundled, system } = await observeLaunch(fixture, marker);
    expect(launch?.command).toBe(fixture.systemVersion === "2.1.329" ? bundled : system);
    expect(launch?.args.join(" ")).not.toContain(marker);
    expect(launch?.args.includes("--strict-mcp-config")).toBe(Boolean(fixture.strict));
    expect(outcome).toBe("prompt");
    expect(commands.slice(0, commandsBeforePrompt).find((command) => command.subtype === fixture.delivery)).toMatchObject(
      fixture.delivery === "initialize" ? { mcpServers } : { servers: mcpServers },
    );
    expect(commands.filter((command) => "mcpServers" in command || command.subtype === "mcp_set_servers")).toHaveLength(1);
  }), { numRuns: 5, examples: [["00000000-0000-1000-8000-000000000000"]] });
});

it.each(launches)("closes the query when $name rejects MCP config before the prompt", async (fixture) => {
  const result = await observeLaunch({ ...fixture, reject: true }, "fixture-refused");
  expect(result.outcome).toBe("failed");
  expect(result.promptCount).toBe(0);
  expect(result.launch?.args.join(" ")).not.toContain("fixture-refused");
});
