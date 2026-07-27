import { describe, expect, it } from "vitest";
import {
  appendCommandOutputDelta,
  buildLiveToolDetails,
  buildTaskMonitorUsageActivityEntry,
  buildTokenUsageActivityEntry,
  mergeCommandDetail,
  summarizeLiveActivity,
} from "../live-transcript-activity";

describe("buildLiveToolDetails", () => {
  it("surfaces Codex function call activity while reviews run", () => {
    const details = buildLiveToolDetails({
      type: "functionCall",
      call_id: "call-1",
      name: "exec_command",
      status: "completed",
      arguments: {
        cmd: "git diff main",
      },
      output: "diff --git a/app.ts b/app.ts",
    });

    expect(details).toEqual([
      {
        id: "call-1",
        kind: "command",
        label: "git diff main",
        status: "completed",
        command: expect.objectContaining({
          displayCommand: "git diff main",
          rawCommand: "git diff main",
        }),
      },
    ]);
  });

  it("surfaces review read/search function calls as live activity", () => {
    const details = buildLiveToolDetails({
      type: "functionCall",
      call_id: "call-search",
      name: "search_query",
      status: "inProgress",
      arguments: {
        query: "review/start app server",
      },
    });

    expect(details).toEqual([
      {
        id: "call-search",
        kind: "read",
        label: "search query: review/start app server",
        status: "in_progress",
      },
    ]);
  });

  it("labels Codex command searches with the query instead of the root path", () => {
    const details = buildLiveToolDetails({
      type: "commandExecution",
      id: "command-search",
      status: "completed",
      command: "rg -n -i 'grok' .",
      commandActions: [
        {
          type: "search",
          command: "rg -n -i 'grok' .",
          query: "grok",
          path: ".",
        },
      ],
    });

    expect(details).toEqual([
      {
        id: "command-search",
        kind: "read",
        label: 'Searched "grok"',
        status: "completed",
        command: expect.objectContaining({
          displayCommand: "rg -n -i 'grok' .",
          rawCommand: "rg -n -i 'grok' .",
        }),
      },
    ]);
  });

  it("uses a quiet search label when Codex only identifies the root path", () => {
    const details = buildLiveToolDetails({
      type: "commandExecution",
      id: "command-search-root",
      status: "completed",
      command: "rg --files .",
      commandActions: [
        {
          type: "search",
          command: "rg --files .",
          query: null,
          path: ".",
        },
      ],
    });

    expect(details[0]?.label).toBe("Searched");
  });

  it("surfaces collaboration agent activity from live tool items", () => {
    const details = buildLiveToolDetails({
      type: "collabAgentToolCall",
      id: "collab-spawn-1",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["019e5630-b147-7980-9f33-3cd7997c235a"],
      prompt: "You are the correctness reviewer.",
      agentsStates: {
        "019e5630-b147-7980-9f33-3cd7997c235a": {
          status: "running",
          message: "Inspecting the diff.\nStill running reviewer output.",
        },
      },
    });

    expect(details).toEqual([
      {
        id: "collab-spawn-1",
        kind: "command",
        label: "Spawning agent 019e5630",
        status: "in_progress",
        command: expect.objectContaining({
          displayCommand: "spawnAgent 019e5630",
          output: expect.stringContaining("Prompt: You are the correctness reviewer."),
        }),
      },
    ]);
    expect(details[0]?.command?.output).toContain("Still running reviewer output.");
  });
});

describe("appendCommandOutputDelta", () => {
  it("caps accumulated live command output before it can grow unbounded in renderer state", () => {
    const entry = appendCommandOutputDelta(
      {
        type: "activity",
        id: "activity-1",
        summary: "Ran command",
        status: "in_progress",
        details: [
          {
            id: "cmd-1",
            kind: "command",
            label: "cat protocol-capture.json",
            command: {
              displayCommand: "cat protocol-capture.json",
              output: "start\n",
            },
          },
        ],
      },
      {
        itemId: "cmd-1",
        delta: `{"backend":"codex","captureId":"large"}${"x".repeat(80_000)}tail`,
      },
    );

    const output = entry.details[0]?.command?.output ?? "";
    expect(output.length).toBeLessThan(36_000);
    expect(output).toContain("PwrAgent renderer boundary: truncated");
    expect(output).toContain("original length");
    expect(output).not.toContain("x".repeat(60_000));
  });
});

describe("mergeCommandDetail", () => {
  it("keeps a structured invocation when a sparse completion uses a generic command", () => {
    expect(
      mergeCommandDetail(
        {
          displayCommand:
            'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
          source: "tool",
        },
        {
          displayCommand: "tool",
          source: "tool",
          output: "found 9 matches",
        },
      ),
    ).toEqual({
      displayCommand:
        'grep(pattern="grok", glob="*.{ts,tsx,md,json}", head_limit=20)',
      source: "tool",
      output: "found 9 matches",
    });
  });

  it("promotes a tool invocation to shell when a raw command arrives", () => {
    expect(
      mergeCommandDetail(
        {
          displayCommand: 'grep(pattern="grok")',
          source: "tool",
        },
        {
          displayCommand: "rg -n grok .",
          rawCommand: "rg -n grok .",
        },
      ),
    ).toEqual({
      displayCommand: "rg -n grok .",
      rawCommand: "rg -n grok .",
      source: "shell",
    });
  });
});

describe("buildTokenUsageActivityEntry", () => {
  it("summarizes cached, uncached, output, reasoning, and list-price cost", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-1",
      model: "gpt-5.5",
      tokenUsage: {
        last_token_usage: {
          input_tokens: 21_981,
          cached_input_tokens: 2_432,
          output_tokens: 174,
          reasoning_output_tokens: 25,
        },
      },
      turn: { id: "turn-1", status: "in_progress" },
    });

    expect(entry).toMatchObject({
      type: "activity",
      id: "usage-1",
      summary: expect.stringContaining("Latest request usage: 19,549 uncached in"),
      status: "completed",
      turn: { id: "turn-1" },
    });
    expect(entry?.summary).toContain("2,432 cached");
    expect(entry?.summary).toContain("174 out (25 reasoning)");
    expect(entry?.summary).toContain("$0.11 list price");
    expect(entry?.details.map((detail) => detail.label)).toEqual([
      "Input: 21,981 tokens (19,549 uncached, 2,432 cached)",
      "Output: 174 tokens, including 25 reasoning",
      "Uncached input cost: 19,549 tokens at $5.00/M = $0.098",
      "Cached input cost: 2,432 tokens at $0.50/M (0.1x uncached) = $0.002",
      "Output cost: 199 tokens at $30.00/M = $0.006",
      "Cost: $0.11 list price for GPT-5.5 Standard",
    ]);
  });

  it("uses Fast priority rates and labels the model variant", () => {
    const entry = buildTokenUsageActivityEntry({
      fastMode: true,
      id: "usage-fast",
      model: "gpt-5.5",
      tokenUsage: {
        total: {
          inputTokens: 27_697,
          cachedInputTokens: 10_112,
          outputTokens: 95,
        },
      },
    });

    expect(entry?.summary).toContain("17,585 uncached in");
    expect(entry?.summary).toContain("10,112 cached");
    expect(entry?.summary).toContain("$0.24 list price");
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Uncached input cost: 17,585 tokens at $12.50/M 2.5x Standard = $0.22",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Cached input cost: 10,112 tokens at $1.25/M (0.1x uncached, 2.5x Standard) = $0.013",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Output cost: 95 tokens at $75.00/M 2.5x Standard = $0.008",
    );
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $0.24 list price for GPT-5.5 Fast (Priority)",
    );
  });

  it("uses GPT-5.4 Fast priority rates with a 2x standard multiplier", () => {
    const entry = buildTokenUsageActivityEntry({
      fastMode: true,
      id: "usage-fast-54",
      model: "gpt-5.4",
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 200,
          outputTokens: 100,
        },
      },
    });

    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Uncached input cost: 800 tokens at $5.00/M 2.0x Standard = $0.004",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Cached input cost: 200 tokens at $0.50/M (0.1x uncached, 2.0x Standard) = <$0.001",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Output cost: 100 tokens at $30.00/M 2.0x Standard = $0.003",
    );
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $0.008 list price for GPT-5.4 Fast (Priority)",
    );
  });

  it("rounds list-price costs below ten cents to tenths of a penny", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-small-cost",
      model: "gpt-5.4-mini",
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 0,
          outputTokens: 1_000,
        },
      },
    });

    expect(entry?.summary).toContain("Usage: 1,000 uncached in");
    expect(entry?.summary).toContain("$0.006 list price");
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Uncached input cost: 1,000 tokens at $0.75/M = <$0.001",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Cached input cost: 0 tokens at $0.075/M (0.1x uncached) = $0.000",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Output cost: 1,000 tokens at $4.50/M = $0.005",
    );
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $0.006 list price for GPT-5.4 mini Standard",
    );
  });

  it("uses standard Codex rates above 128K aggregate input tokens", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-large-aggregate",
      model: "gpt-5.5",
      tokenUsage: {
        total: {
          inputTokens: 130_000,
          cachedInputTokens: 20_000,
          outputTokens: 1_000,
        },
      },
    });

    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Uncached input cost: 110,000 tokens at $5.00/M = $0.55",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Cached input cost: 20,000 tokens at $0.50/M (0.1x uncached) = $0.010",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Output cost: 1,000 tokens at $30.00/M = $0.030",
    );
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $0.59 list price for GPT-5.5 Standard",
    );
  });

  it("uses Fast priority Codex rates above 128K aggregate input tokens", () => {
    const entry = buildTokenUsageActivityEntry({
      fastMode: true,
      id: "usage-fast-large-aggregate",
      model: "gpt-5.5",
      tokenUsage: {
        total: {
          inputTokens: 130_000,
          cachedInputTokens: 20_000,
          outputTokens: 1_000,
        },
      },
    });

    expect(entry?.summary).toBe("Usage: 110,000 uncached in · 20,000 cached · 1,000 out · $1.48 list price");
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Uncached input cost: 110,000 tokens at $12.50/M 2.5x Standard = $1.38",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Cached input cost: 20,000 tokens at $1.25/M (0.1x uncached, 2.5x Standard) = $0.025",
    );
    expect(entry?.details.map((detail) => detail.label)).toContain(
      "Output cost: 1,000 tokens at $75.00/M 2.5x Standard = $0.075",
    );
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: $1.48 list price for GPT-5.5 Fast (Priority)",
    );
  });

  it("does not estimate unsupported service tiers as Standard", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-flex-tier",
      model: "gpt-5.5",
      serviceTier: "flex",
      tokenUsage: {
        total: {
          inputTokens: 1_000,
          cachedInputTokens: 200,
          outputTokens: 100,
        },
      },
    });

    expect(entry?.summary).toBe("Usage: 800 uncached in · 200 cached · 100 out");
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost unavailable: no local pricing entry for gpt-5.5 service tier flex",
    );
  });

  it("reports unavailable cost without dropping token accounting", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-unknown",
      model: "custom-model",
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
        },
      },
    });

    expect(entry?.summary).toBe("Usage: 80 uncached in · 20 cached · 30 out");
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost unavailable: no local pricing entry for custom-model",
    );
  });

  it("does not estimate cost for Codex Spark without a local API price", () => {
    const entry = buildTokenUsageActivityEntry({
      id: "usage-spark",
      model: "gpt-5.3-codex-spark",
      tokenUsage: {
        total: {
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
        },
      },
    });

    expect(entry?.summary).toBe("Usage: 80 uncached in · 20 cached · 30 out");
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost unavailable: no local pricing entry for gpt-5.3-codex-spark",
    );
  });
});

describe("buildTaskMonitorUsageActivityEntry", () => {
  it("renders structured monitor usage metadata as a top-level activity", () => {
    const entry = buildTaskMonitorUsageActivityEntry({
      id: "monitor-usage-1",
      item: {
        id: "monitor-progress-1",
        type: "agentMessage",
        text: "Still running.",
        data: {
          source: "pwragent_task_monitor",
          monitorId: "monitor-1",
          monitorUsage: {
            phase: "progress",
            model: "gpt-5.4-mini",
            tokenUsage: {
              inputTokens: 1_000,
              cachedInputTokens: 200,
              outputTokens: 50,
              reasoningOutputTokens: 10,
            },
          },
        },
      },
      turn: { id: "monitor:monitor-1", status: "completed" },
    });

    expect(entry).toMatchObject({
      type: "activity",
      id: "monitor-usage-1",
      summary: "Monitor usage so far: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
      status: "completed",
      turn: { id: "monitor:monitor-1" },
    });
    expect(entry?.details.at(-1)?.label).toBe(
      "Cost: <$0.001 list price for GPT-5.4 mini Standard",
    );
  });
});

describe("Windows command rendering", () => {
  it("strips the PowerShell interpreter wrapper from the command label", () => {
    const details = buildLiveToolDetails({
      type: "commandExecution",
      id: "cmd-1",
      command:
        '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "git status"',
      status: "completed",
    });

    expect(details[0]?.label).toBe("git status");
    expect(details[0]?.command?.displayCommand).toBe("git status");
    // The full interpreter invocation is preserved for the details view.
    expect(details[0]?.command?.rawCommand).toContain("powershell.exe");
  });

  it("strips a POSIX login-shell wrapper from the command label", () => {
    const details = buildLiveToolDetails({
      type: "commandExecution",
      id: "cmd-2",
      command: "/bin/zsh -lc 'git status'",
      status: "completed",
    });

    expect(details[0]?.label).toBe("git status");
  });

  it("strips a quoted Git-bash wrapper whose path contains spaces", () => {
    const details = buildLiveToolDetails({
      type: "commandExecution",
      id: "cmd-3",
      command:
        '"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git status"',
      status: "completed",
    });

    expect(details[0]?.label).toBe("git status");
    expect(details[0]?.command?.displayCommand).toBe("git status");
    // The full interpreter invocation is preserved for the details view.
    expect(details[0]?.command?.rawCommand).toContain("bash.exe");
  });

  it("does not collapse a Windows drive-letter path label to 'C'", () => {
    const summary = summarizeLiveActivity([
      {
        id: "cmd-1",
        kind: "command",
        label:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command git status",
        status: "completed",
      },
    ]);

    expect(summary).not.toBe("C");
    expect(summary).toContain("powershell.exe");
  });
});
