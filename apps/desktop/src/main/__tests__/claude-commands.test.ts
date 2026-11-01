import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SlashCommand, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AppServerAvailableCommandSummary } from "@pwragent/shared";
import { ClaudeBackend, type ClaudeBackendOptions } from "../claude/claude-backend";
import { CLAUDE_TERMINAL_COMMANDS_SEED, claudeCommandSummaries } from "../claude/claude-commands";
import { readClaudeMcpServerStatus } from "../claude/claude-models";
import { ClaudeSessionStore } from "../claude/claude-session-store";

// Record a missing fixture seam without launching the SDK's real Git probes.
const sdkGetSessionInfo = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>(),
  getSessionInfo: sdkGetSessionInfo,
}));

const roots: string[] = [];
const backends: ClaudeBackend[] = [];
afterEach(async () => {
  try {
    await Promise.all(backends.splice(0).map((backend) => backend.close()));
    expect(sdkGetSessionInfo).not.toHaveBeenCalled();
  } finally {
    sdkGetSessionInfo.mockClear();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  }
});

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name, description: `${name} description`, argumentHint: "", ...extra,
});

async function fixture(params: {
  messages?: () => AsyncGenerator<SDKMessage>;
  supportedCommands?: () => Promise<SlashCommand[]>;
  readCommands?: ClaudeBackendOptions["readCommands"];
  readMcpServers?: ClaudeBackendOptions["readMcpServers"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-commands-"));
  roots.push(root);
  const events: AgentEvent[] = [];
  const run = vi.fn((_args: Parameters<typeof query>[0]) => Object.assign(params.messages!(), {
    close: vi.fn(), supportedCommands: params.supportedCommands,
  }) as unknown as Query);
  const backend = new ClaudeBackend({
    store: new ClaudeSessionStore(root),
    query: run,
    getSessionInfo: async () => undefined,
    discoverModels: async () => [],
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const }),
    readCommands: params.readCommands,
    readMcpServers: params.readMcpServers,
    resolveEnv: async () => ({ PATH: "/fixture" }),
    emit: async (event) => { events.push(event); },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
  });
  backends.push(backend);
  return { backend, events, root };
}

describe("claudeCommandSummaries", () => {
  it("hides terminal and internal commands and prefers the built-in row of a shared name", () => {
    const summaries = claudeCommandSummaries([
      command("review", { description: "project review" }),
      command("code-review", { builtin: true, aliases: ["review"] }),
      command("compact", { builtin: true }),
      command("compact", { description: "plugin compact" }),
      command("doctor", { builtin: true }),
      command("__remote-workflow", { builtin: true }),
      command("deploy", { description: "" }),
    ], new Set(["doctor"]));
    expect(summaries).toEqual([
      { name: "review", description: "project review", backend: "claude", scope: "session", source: "provider" },
      { name: "code-review", description: "code-review description", aliases: ["review"],
        backend: "claude", scope: "session", source: "provider" },
      { name: "compact", description: "compact description", backend: "claude", scope: "session", source: "provider" },
      { name: "deploy", backend: "claude", scope: "session", source: "provider" },
    ]);
  });

  it("offers the artifact commands Claude Code 2.1.303 lists once artifacts are on", () => {
    // Captured from supportedCommands() with CLAUDE_CODE_ARTIFACT=1; the
    // same session's terminal_slash_commands was the seed list.
    const summaries = claudeCommandSummaries([
      command("design", { description: "Make a new Design artifact from a brief", argumentHint: "[what to design]" }),
      command("slides", { description: "Make a new Slides deck artifact from a brief", argumentHint: "[what the deck is about]" }),
      command("artifact-diagramming"),
      command("artifact-capabilities"),
    ], new Set(CLAUDE_TERMINAL_COMMANDS_SEED));
    expect(summaries.map((summary) => summary.name)).toEqual([
      "design", "slides", "artifact-diagramming", "artifact-capabilities",
    ]);
    expect(summaries[0]).toMatchObject({ description: "Make a new Design artifact from a brief", backend: "claude" });
  });
});

describe("Claude slash commands", () => {
  it("publishes a live turn's commands and serves them without a probe", async () => {
    const readCommands = vi.fn(async () => [command("probe-only")]);
    const f = await fixture({
      readCommands,
      supportedCommands: async () => [command("init"), command("focus"), command("doctor")],
      async *messages() {
        yield { type: "system", subtype: "init", session_id: "5a85c1ad-85c1-4930-ae19-50f721ad13dd",
          terminal_slash_commands: ["focus"] } as unknown as SDKMessage;
        yield { type: "system", subtype: "commands_changed", commands: [command("init"), command("skill-in-subdir")] } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "" } as unknown as SDKMessage;
      },
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "/init" }] });
    await vi.waitFor(() => expect(f.events.some((event) => event.notification.method === "turn/completed")).toBe(true));

    const updates = f.events.flatMap((event) => event.notification.method === "thread/availableCommands/updated"
      ? [event.notification.params as { threadId: string; commands: AppServerAvailableCommandSummary[] }] : []);
    // The live list replaces the seed: `doctor` is no longer terminal-only, `focus` is.
    expect(updates.map((update) => update.commands.map((entry) => entry.name))).toEqual([
      ["init", "doctor"], ["init", "skill-in-subdir"],
    ]);
    expect(updates.every((update) => update.threadId === threadId)).toBe(true);
    expect((await f.backend.listCommands({ threadId })).map((entry) => entry.name)).toEqual(["init", "skill-in-subdir"]);
    // A launchpad in the same folder reuses what the thread reported.
    expect((await f.backend.listCommands({ cwd: f.root })).map((entry) => entry.name)).toEqual(["init", "skill-in-subdir"]);
    expect(readCommands).not.toHaveBeenCalled();
  });

  it("probes a new folder once, shares the probe, and caches the answer", async () => {
    const answer = Promise.withResolvers<SlashCommand[]>();
    const readCommands = vi.fn(() => answer.promise);
    const f = await fixture({ readCommands });
    const first = f.backend.listCommands({ cwd: f.root });
    const second = f.backend.listCommands({ cwd: f.root });
    await vi.waitFor(() => expect(readCommands).toHaveBeenCalledTimes(1));
    expect(readCommands).toHaveBeenCalledWith(expect.objectContaining({ executable: "/fixture/claude", cwd: f.root }));
    answer.resolve([command("deploy"), command("doctor", { builtin: true })]);
    expect((await first).map((entry) => entry.name)).toEqual(["deploy"]);
    expect((await second).map((entry) => entry.name)).toEqual(["deploy"]);
    expect((await f.backend.listCommands({ cwd: f.root })).map((entry) => entry.name)).toEqual(["deploy"]);
    expect(readCommands).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failed probe instead of spawning per keystroke", async () => {
    const readCommands = vi.fn(async (): Promise<SlashCommand[]> => { throw new Error("timed out"); });
    const f = await fixture({ readCommands });
    expect(await f.backend.listCommands({ cwd: f.root })).toEqual([]);
    expect(await f.backend.listCommands({ cwd: f.root })).toEqual([]);
    expect(readCommands).toHaveBeenCalledTimes(1);
    expect(await f.backend.listCommands({})).toEqual([]);
  });
});

describe("Claude MCP inventory", () => {
  it("asks Claude Code for its own config's servers while the thread is idle", async () => {
    const readMcpServers = vi.fn(async () => [
      { name: "acme-docs", status: "connected" as const, tools: [{ name: "search_docs" }] },
      { name: "weather-lab", status: "needs-auth" as const },
    ]);
    const f = await fixture({ readMcpServers });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });

    expect(await f.backend.listMcpServers(threadId)).toEqual([
      { name: "acme-docs", authStatus: "unsupported", startupStatus: "ready", startupError: undefined, tools: ["search_docs"] },
      { name: "weather-lab", authStatus: "notLoggedIn", startupStatus: "failed", startupError: undefined, tools: [] },
    ]);
    expect(readMcpServers).toHaveBeenCalledWith(expect.objectContaining({ executable: "/fixture/claude", cwd: f.root }));
  });
});

describe("readClaudeMcpServerStatus", () => {
  it("loads Claude's own MCP config and waits for pending servers to settle", async () => {
    const mcpServerStatus = vi.fn()
      .mockResolvedValueOnce([{ name: "acme-docs", status: "pending" }])
      .mockResolvedValueOnce([{ name: "acme-docs", status: "connected", tools: [{ name: "search_docs" }] }]);
    const run = vi.fn((_args: Parameters<typeof query>[0]) => ({ mcpServerStatus, close: vi.fn() }) as unknown as Query);

    const servers = await readClaudeMcpServerStatus({
      executable: "/fixture/claude", env: {}, cwd: "/fixture/project", query: run as unknown as typeof query,
    });

    expect(servers).toEqual([{ name: "acme-docs", status: "connected", tools: [{ name: "search_docs" }] }]);
    expect(mcpServerStatus).toHaveBeenCalledTimes(2);
    const options = run.mock.calls[0][0].options;
    expect(options).toMatchObject({ cwd: "/fixture/project", tools: [] });
    expect(options).not.toHaveProperty("strictMcpConfig");
    expect(options).not.toHaveProperty("mcpServers");
  });

  it("shares one idle probe between overlapping requests", async () => {
    const answer = Promise.withResolvers<Awaited<ReturnType<NonNullable<ClaudeBackendOptions["readMcpServers"]>>>>();
    const readMcpServers = vi.fn(() => answer.promise);
    const f = await fixture({ readMcpServers });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const first = f.backend.listMcpServers(threadId);
    const second = f.backend.listMcpServers(threadId);
    await vi.waitFor(() => expect(readMcpServers).toHaveBeenCalledTimes(1));
    answer.resolve([{ name: "acme-docs", status: "connected" }]);
    expect((await first).map((server) => server.name)).toEqual(["acme-docs"]);
    expect((await second).map((server) => server.name)).toEqual(["acme-docs"]);
    expect(readMcpServers).toHaveBeenCalledTimes(1);
  });
});
