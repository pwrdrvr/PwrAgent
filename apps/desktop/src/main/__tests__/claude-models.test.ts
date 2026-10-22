import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, Query, query } from "@anthropic-ai/claude-agent-sdk";
import { claudeModelOptions, discoverClaudeModels } from "../claude/claude-models";

const catalogLog = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => catalogLog }));

const model = (value: string, displayName: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  value, displayName, description: "Fixture model", ...extra,
});

describe("Claude model catalog", () => {
  it("labels the SDK's generic catalog using resolved versions without changing selectable IDs", () => {
    const options = claudeModelOptions([
      model("default", "Default (recommended)", { resolvedModel: "claude-opus-5-5" }),
      model("opus", "Opus", { resolvedModel: "claude-opus-5-5" }),
      model("claude-fable-5-1[1m]", "Fable", { resolvedModel: "claude-fable-5-1" }),
      model("sonnet", "Sonnet", { resolvedModel: "claude-sonnet-5-5" }),
      model("haiku", "Haiku", { resolvedModel: "claude-haiku-5-5" }),
    ]);
    expect(options.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "opus", label: "Opus 5.5" },
      { id: "claude-fable-5-1[1m]", label: "Fable 5.1 (1M context)" },
      { id: "sonnet", label: "Sonnet 5.5" },
      { id: "haiku", label: "Haiku 5.5" },
    ]);
    expect(options.filter((option) => option.current).map((option) => option.id)).toEqual(["opus"]);
  });

  it("groups resolved older versions and preserves explicit, custom, and unresolved labels", () => {
    const options = claudeModelOptions([
      model("opus", "Opus", { resolvedModel: "claude-opus-5-5" }),
      model("claude-opus-5", "Claude Opus"),
      model("claude-opus-4-8-20260101", "Opus"),
      model("explicit", "Opus 5.5 (extended context)", { resolvedModel: "claude-opus-5-5[1m]" }),
      model("custom", "My organization model", { resolvedModel: "claude-opus-5-5" }),
      model("unresolved", "Haiku"),
      model("opaque", "Sonnet", { resolvedModel: "provider-specific-id" }),
    ]);
    expect(options.slice(0, 3).map(({ label, other }) => ({ label, other }))).toEqual([
      { label: "Opus 5.5", other: undefined },
      { label: "Claude Opus 5", other: true },
      { label: "Opus 4.8", other: true },
    ]);
    expect(options.slice(3).map((option) => option.label)).toEqual([
      "Opus 5.5 (extended context)", "My organization model", "Haiku", "Sonnet",
    ]);
  });

  it("logs aggregate catalog provenance without custom names or model IDs", () => {
    catalogLog.info.mockClear();
    claudeModelOptions([
      model("opus", "Opus", { resolvedModel: "claude-opus-5-5" }),
      model("sonnet", "Sonnet 5.5"),
      model("private-deployment-id", "Private organization model"),
    ], { source: "session", cliVersion: "2.1.296" });
    expect(catalogLog.info.mock.calls).toEqual([["Claude model catalog received", {
      source: "session", cliVersion: "2.1.296", modelCount: 3,
      versionedNameCount: 1, resolvedGenericNameCount: 1,
    }]]);
  });

  it("uses versioned CLI names, keeps the latest family versions primary, and removes the duplicate default row", () => {
    const options = claudeModelOptions([
      model("default", "Default (recommended)", { resolvedModel: "claude-fable-5-1" }),
      model("opus", "Opus 5.5"),
      model("fable", "Fable 5.1", { resolvedModel: "claude-fable-5-1" }),
      model("sonnet", "Sonnet 5.5"),
      model("haiku", "Haiku 5.5"),
      model("claude-opus-4-8", "Opus 4.8"),
      model("claude-sonnet-5", "Sonnet 5"),
      model("claude-fable-5", "Fable 5"),
      model("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ]);
    expect(options.filter((option) => !option.other).map((option) => option.label))
      .toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
    expect(options.filter((option) => option.other).map((option) => option.id))
      .toEqual(["claude-opus-4-8", "claude-sonnet-5", "claude-fable-5", "claude-haiku-4-5-20251001"]);
    expect(options.filter((option) => option.current).map((option) => option.id)).toEqual(["fable"]);
  });

  it("compares numeric versions in any catalog order and preserves unknown/custom models", () => {
    const options = claudeModelOptions([
      model("old", "Claude Future 6.9"), model("new", "Future 6.10"),
      model("custom", "My organization model"), model("default", "Default (recommended)"),
    ]);
    expect(options.filter((option) => option.other).map((option) => option.id)).toEqual(["old"]);
    expect(options.find((option) => option.id === "default")?.current).toBe(true);
  });

  it("exposes only the effort levels advertised for each model", () => {
    const options = claudeModelOptions([
      model("opus", "Opus 5.5", { supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] }),
      model("older", "Haiku 4.5"),
    ]);
    expect(options[0]).toMatchObject({ supportsReasoning: true, defaultReasoningEffort: "default", reasoningEfforts: ["default", "low", "high", "max"] });
    expect(options[1]).toMatchObject({ supportsReasoning: false, reasoningEfforts: [] });
  });

  it("reads metadata through the official executable without sending a prompt, and closes the session", async () => {
    const close = vi.fn();
    const run = vi.fn(() => ({ supportedModels: async () => [model("fable", "Fable 5.1")], close }) as unknown as Query);
    await expect(discoverClaudeModels({ executable: "/fixture/claude", env: { PATH: "/fixture" }, query: run }))
      .resolves.toMatchObject([{ id: "fable", label: "Fable 5.1" }]);
    const args = (run.mock.calls as unknown as [Parameters<typeof query>[0]][])[0][0];
    expect(args.options).toMatchObject({ pathToClaudeCodeExecutable: "/fixture/claude", persistSession: false,
      systemPrompt: { type: "preset", preset: "claude_code" }, settingSources: ["user", "project", "local"],
      tools: [], strictMcpConfig: true,
    });
    expect(typeof args.prompt).not.toBe("string");
    if (typeof args.prompt !== "string") expect(await args.prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["empty", "failure", "timeout"])("closes discovery on %s", async (failure) => {
    vi.useFakeTimers();
    const close = vi.fn();
    const supportedModels = async () => {
      if (failure === "failure") throw new Error("CLI unavailable");
      if (failure === "timeout") return await new Promise<ModelInfo[]>(() => {});
      return [];
    };
    try {
      const pending = discoverClaudeModels({ executable: "/fixture/claude", env: {},
        query: () => ({ supportedModels, close }) as unknown as Query });
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
