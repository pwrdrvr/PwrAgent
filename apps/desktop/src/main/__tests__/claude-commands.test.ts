import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SDKUserMessage, SlashCommand, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { AppServerAvailableCommandSummary } from "@pwragent/shared/contracts/normalized-app-server";
import { ClaudeBackend, type ClaudeBackendOptions } from "../claude/claude-backend";
import {
  CLAUDE_TERMINAL_COMMANDS_SEED,
  claudeCommandSummaries,
  isClaudeCompactCommandAvailable,
} from "../claude/claude-commands";
import { readClaudeCatalog, readClaudeMcpServerStatus } from "../claude/claude-models";
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
  getContextUsage?: () => Promise<unknown>;
  readCommands?: ClaudeBackendOptions["readCommands"];
  readCatalog?: ClaudeBackendOptions["readCatalog"];
  findSkillFiles?: ClaudeBackendOptions["findSkillFiles"];
  readMcpServers?: ClaudeBackendOptions["readMcpServers"];
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-commands-"));
  roots.push(root);
  const events: AgentEvent[] = [];
  const run = vi.fn((_args: Parameters<typeof query>[0]) => Object.assign(params.messages!(), {
    close: vi.fn(), supportedCommands: params.supportedCommands, getContextUsage: params.getContextUsage,
  }) as unknown as Query);
  const backend = new ClaudeBackend({
    store: new ClaudeSessionStore(root),
    query: run,
    getSessionInfo: async () => undefined,
    discoverModels: async () => [],
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const }),
    readCommands: params.readCommands,
    readCatalog: params.readCatalog,
    // Never look in the operator's own Claude folder.
    findSkillFiles: params.findSkillFiles ?? (async () => new Map()),
    readMcpServers: params.readMcpServers,
    resolveEnv: async () => ({ PATH: "/fixture" }),
    emit: async (event) => { events.push(event); },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
  });
  backends.push(backend);
  return { backend, events, root, run };
}

// The fixture's empty result ends a plain prompt's turn as failed; these
// tests are about what was sent and listed, not how the turn ended.
const turnsEnded = (events: AgentEvent[]) => events.filter((event) =>
  event.notification.method === "turn/completed" || event.notification.method === "turn/failed").length;

const skillListing = (root: string, ...names: string[]) => ({
  totalTokens: 10, maxTokens: 1000,
  skills: { totalSkills: names.length, includedSkills: names.length, tokens: names.length, skillFrontmatter: names.map((name) => ({
    name, source: "projectSettings", path: path.join(root, ".claude", "skills", name, "SKILL.md"), tokens: 1,
  })) },
});

async function sentPrompt(run: ReturnType<typeof vi.fn>, call: number): Promise<SDKUserMessage["message"]["content"]> {
  const args = run.mock.calls[call]?.[0] as Parameters<typeof query>[0] | undefined;
  if (!args) throw new Error(`Claude was not started ${call + 1} times`);
  const { prompt } = args;
  if (typeof prompt === "string") throw new Error("Expected streaming input");
  return (await prompt[Symbol.asyncIterator]().next()).value.message.content;
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

  it("carries the argument hint Claude reports, so the composer can teach a command's arguments", () => {
    const summaries = claudeCommandSummaries([
      command("code-review", { builtin: true, argumentHint: " [low|medium|high] [--fix] " }),
      command("compact", { builtin: true, argumentHint: "  " }),
    ], new Set());
    expect(summaries[0]?.argumentHint).toBe("[low|medium|high] [--fix]");
    expect(summaries[1]).not.toHaveProperty("argumentHint");
  });

  it("checks observed commands and terminal_slash_commands for /compact availability", () => {
    const seed = new Set(CLAUDE_TERMINAL_COMMANDS_SEED);
    // Unobserved workspace allows compact without forcing an extra probe.
    expect(isClaudeCompactCommandAvailable(undefined, seed)).toBe(true);
    // Terminal-only compact is always refused, even before a command list arrives.
    expect(isClaudeCompactCommandAvailable(undefined, new Set(["compact"]))).toBe(false);
    expect(isClaudeCompactCommandAvailable(
      [{ name: "compact", backend: "claude", scope: "session", source: "provider" }],
      new Set(["/compact"]),
    )).toBe(false);
    // Observed command list must include compact (by name or alias).
    expect(isClaudeCompactCommandAvailable(
      [{ name: "compact", backend: "claude", scope: "session", source: "provider" }],
      seed,
    )).toBe(true);
    expect(isClaudeCompactCommandAvailable(
      [{ name: "summarize", aliases: ["compact"], backend: "claude", scope: "session", source: "provider" }],
      seed,
    )).toBe(true);
    expect(isClaudeCompactCommandAvailable(
      [{ name: "init", backend: "claude", scope: "session", source: "provider" }],
      seed,
    )).toBe(false);
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

  it("lists the skills Claude reports under $ and keeps commands under /", async () => {
    const f = await fixture({
      supportedCommands: async () => [command("init", { builtin: true }), command("release"), command("deploy")],
      getContextUsage: async () => skillListing(f.root, "release"),
      async *messages() {
        yield { type: "system", subtype: "init", session_id: "8f0d2c6e-56b9-4c1f-9e43-6f7a4a1d9b20" } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "" } as unknown as SDKMessage;
      },
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "hello" }] });
    await vi.waitFor(() => expect(turnsEnded(f.events)).toBe(1));

    const methods = f.events.map((event) => event.notification.method)
      .filter((method) => method === "thread/availableCommands/updated" || method === "skills/changed");
    // The composer that holds the command update asks for the skills next.
    expect(methods).toEqual(["thread/availableCommands/updated", "skills/changed"]);
    const update = f.events.find((event) => event.notification.method === "thread/availableCommands/updated")!
      .notification.params as { commands: AppServerAvailableCommandSummary[] };
    expect(update.commands.map((entry) => entry.name)).toEqual(["init", "deploy"]);
    const catalog = await f.backend.listCatalog({ threadId });
    expect(catalog.skills).toEqual([{
      name: "release", description: "release description",
      path: path.join(f.root, ".claude", "skills", "release", "SKILL.md"), enabled: true, scope: "repo",
    }]);
  });

  it("sends a $skill mention as the /skill Claude starts", async () => {
    const f = await fixture({
      supportedCommands: async () => [command("release"), command("deploy")],
      getContextUsage: async () => skillListing(f.root, "release"),
      async *messages() {
        yield { type: "system", subtype: "init", session_id: "1c3e9a52-7d4b-4e8f-a1b6-2f5c8d9e0a13" } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "" } as unknown as SDKMessage;
      },
    });
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    const turns = () => turnsEnded(f.events);
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "$release first" }] });
    await vi.waitFor(() => expect(turns()).toBe(1));
    await vi.waitFor(async () => expect((await f.backend.listCatalog({ threadId })).skills).toHaveLength(1));
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "$release v2, not $deploy" }] });
    await vi.waitFor(() => expect(turns()).toBe(2));

    // Before Claude has listed its skills, only a picked link is rewritten.
    expect(await sentPrompt(f.run, 0)).toEqual([{ type: "text", text: "$release first" }]);
    expect(await sentPrompt(f.run, 1)).toEqual([{ type: "text", text: "/release v2, not $deploy" }]);
    // The transcript keeps what the operator typed.
    const sentText = f.events.flatMap((event) => {
      if (event.notification.method !== "item/completed") return [];
      const item = event.notification.params.item as { type?: string; text?: string };
      return item.type === "userMessage" ? [item.text] : [];
    });
    expect(sentText).toEqual(["$release first", "$release v2, not $deploy"]);
  });

  it("probes commands and skills together and finds skills Claude hides from the model", async () => {
    const readCatalog = vi.fn(async ({ cwd }: { cwd: string }) => ({
      commands: [command("release"), command("manual-only"), command("deploy"), command("review", { builtin: true })],
      skills: skillListing(cwd, "release").skills.skillFrontmatter,
    }));
    const findSkillFiles = vi.fn(async ({ names }: { names: readonly string[] }) => new Map(names
      .filter((name) => name === "manual-only")
      .map((name) => [name, { path: `/home/.claude/skills/${name}/SKILL.md`, scope: "claude-user" as const }])));
    const f = await fixture({ readCatalog, findSkillFiles });
    const catalog = await f.backend.listCatalog({ cwd: f.root });
    expect(catalog.commands.map((entry) => entry.name)).toEqual(["deploy", "review"]);
    expect(catalog.skills.map((entry) => [entry.name, entry.scope])).toEqual([["release", "repo"], ["manual-only", "claude-user"]]);
    // Only rows Claude's listing did not account for are looked up.
    expect(findSkillFiles).toHaveBeenCalledWith(expect.objectContaining({ cwd: f.root, names: ["manual-only", "deploy"] }));
    expect(await f.backend.listCommands({ cwd: f.root })).toEqual(catalog.commands);
    expect(readCatalog).toHaveBeenCalledTimes(1);
  });

  it("keeps a live turn's commands over a probe that finishes while they are being sorted", async () => {
    const probeAnswer = Promise.withResolvers<{ commands: SlashCommand[]; skills: [] }>();
    const readCatalog = vi.fn(() => probeAnswer.promise);
    const liveLookup = Promise.withResolvers<void>();
    const findSkillFiles = vi.fn(async ({ names }: { names: readonly string[] }) => {
      if (names.includes("live-only")) await liveLookup.promise;
      return new Map();
    });
    const f = await fixture({
      readCatalog,
      findSkillFiles,
      supportedCommands: async () => [command("release"), command("live-only")],
      getContextUsage: async () => skillListing(f.root, "release"),
      async *messages() {
        yield { type: "system", subtype: "init", session_id: "3b7f1d2e-9c4a-4e6b-8d1f-5a2c7e9b0d34" } as unknown as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, result: "" } as unknown as SDKMessage;
      },
    });
    const probe = f.backend.listCatalog({ cwd: f.root });
    await vi.waitFor(() => expect(readCatalog).toHaveBeenCalledTimes(1));
    const { threadId } = await f.backend.startThread({ cwd: f.root, executionMode: "default" });
    await f.backend.startTurn({ threadId, input: [{ type: "text", text: "hello" }] });
    // The live report is sorting its rows when the older probe answer lands.
    await vi.waitFor(() => expect(findSkillFiles).toHaveBeenCalledTimes(1));
    probeAnswer.resolve({ commands: [command("release"), command("probe-only")], skills: [] });
    await probe;
    liveLookup.resolve();
    await vi.waitFor(() => expect(turnsEnded(f.events)).toBe(1));

    expect((await f.backend.listCatalog({ cwd: f.root })).commands.map((entry) => entry.name)).toEqual(["live-only"]);
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

describe("readClaudeCatalog", () => {
  it("loads the Skill tool, without which Claude's context listing names no skills", async () => {
    const supportedCommands = vi.fn(async () => [command("release")]);
    const getContextUsage = vi.fn(async () => skillListing("/fixture/project", "release"));
    const run = vi.fn((_args: Parameters<typeof query>[0]) => ({
      supportedCommands, getContextUsage, close: vi.fn(),
    }) as unknown as Query);

    const catalog = await readClaudeCatalog({
      executable: "/fixture/claude", env: {}, cwd: "/fixture/project", query: run as unknown as typeof query,
    });

    expect(catalog.skills.map((skill) => skill.name)).toEqual(["release"]);
    expect(getContextUsage).toHaveBeenCalledWith({ detail: "summary" });
    // Claude Code 2.1.305 listed 0 skills with `tools: []` and 49 with the Skill tool.
    expect(run.mock.calls[0][0].options).toMatchObject({ cwd: "/fixture/project", tools: ["Skill"], strictMcpConfig: true });
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
