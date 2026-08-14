import type { AppServerThreadReplay } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { analyzeNormalizedToolReplay } from "../app-server/tool-output-replay-analyzer";

describe("normalized tool-output replay analyzer", () => {
  it("classifies structured MCP output and proposes targeted pagination", () => {
    const analysis = analyzeNormalizedToolReplay({
      analyzedAt: 1_800_000_000_000,
      backend: "codex",
      complete: true,
      pages: [replayWithDetail({
        displayCommand: "mcp__github__search({\"query\":\"is:open\"})",
        output: JSON.stringify({ items: Array.from({ length: 600 }, (_, id) => ({ id })) }),
        source: "tool",
      })],
      threadId: "thread-mcp",
    });

    expect(analysis.invocations[0]).toMatchObject({
      category: "mcp",
      noisy: true,
      source: "history",
    });
    expect(analysis.invocations[0]?.suggestedPrompt).toContain(
      "request only targeted fields and use pagination",
    );
    expect(analysis.invocations[0]?.suggestedPrompt).toContain(
      "mcp__github__search",
    );
  });

  it("marks compacted and truncated replay coverage incomplete", () => {
    const compacted = replayWithDetail({
      displayCommand: "sed -n '1,10000p' giant.log",
      label: "Output compacted out of context",
      source: "shell",
    });
    const truncated = replayWithDetail({
      displayCommand: "rg error .",
      output: `${"match\n".repeat(900)}output truncated`,
      source: "shell",
    });
    const analysis = analyzeNormalizedToolReplay({
      analyzedAt: 1_800_000_000_000,
      backend: "codex",
      complete: true,
      pages: [compacted, truncated],
      threadId: "thread-partial",
    });

    expect(analysis.coverage).toMatchObject({
      completeness: "partial",
      missingOutputCount: 1,
      pageCount: 2,
    });
    expect(analysis.coverage.explanation).toContain("lower bound");
    expect(analysis.invocations.map((entry) => entry.outputState)).toEqual([
      "compacted",
      "truncated",
    ]);
  });

  it("attributes inherited normalized replay to a fork with idempotent IDs", () => {
    const inheritedReplay = replayWithDetail({
      displayCommand: "cat inherited-build.log",
      output: "x".repeat(5_000),
      source: "shell",
    });
    const params = {
      analyzedAt: 1_800_000_000_000,
      backend: "codex" as const,
      complete: true,
      pages: [inheritedReplay, inheritedReplay],
      threadId: "fork-thread-id",
    };
    const first = analyzeNormalizedToolReplay(params);
    const second = analyzeNormalizedToolReplay(params);

    expect(first.invocations[0]).toMatchObject({
      threadId: "fork-thread-id",
      turnId: "inherited-turn",
    });
    expect(first.invocations).toHaveLength(1);
    expect(first.coverage.entryCount).toBe(1);
    expect(second.invocations[0]?.invocationId)
      .toBe(first.invocations[0]?.invocationId);
  });
});

function replayWithDetail(params: {
  displayCommand: string;
  label?: string;
  output?: string;
  source: "agent" | "shell" | "tool";
}): AppServerThreadReplay {
  return {
    entries: [{
      type: "activity",
      id: `activity-${params.displayCommand.slice(0, 8)}`,
      createdAt: 1_700_000_000_000,
      status: "completed",
      summary: "Tool call",
      details: [{
        id: "detail-1",
        kind: "command",
        label: params.label ?? params.displayCommand,
        status: "completed",
        command: {
          displayCommand: params.displayCommand,
          exitCode: 0,
          ...(params.output !== undefined ? { output: params.output } : {}),
          source: params.source,
        },
      }],
      turn: {
        id: "inherited-turn",
        status: "completed",
        completedAt: 1_700_000_000_100,
      },
    }],
    messages: [],
    pagination: {
      hasPreviousPage: false,
      supportsPagination: true,
    },
  };
}
