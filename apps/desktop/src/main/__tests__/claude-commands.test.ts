import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query, SDKMessage, SlashCommand, query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AppServerAvailableCommandSummary } from "@pwragent/shared";
import { ClaudeBackend, type ClaudeBackendOptions } from "../claude/claude-backend";
import { claudeCommandSummaries } from "../claude/claude-commands";
import { ClaudeSessionStore } from "../claude/claude-session-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const command = (name: string, extra: Partial<SlashCommand> = {}): SlashCommand => ({
  name, description: `${name} description`, argumentHint: "", ...extra,
});

async function fixture(params: {
  messages?: () => AsyncGenerator<SDKMessage>;
  supportedCommands?: () => Promise<SlashCommand[]>;
  readCommands?: ClaudeBackendOptions["readCommands"];
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
    discoverModels: async () => [],
    inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" as const }),
    readCommands: params.readCommands,
    resolveEnv: async () => ({ PATH: "/fixture" }),
    emit: async (event) => { events.push(event); },
    request: async () => ({ decision: "accept" }),
    cancelRequest: async () => {},
  });
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
