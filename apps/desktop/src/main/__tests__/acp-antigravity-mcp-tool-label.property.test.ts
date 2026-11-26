import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import {
  AcpLiveToolUpdateResolver,
  acpToolUpdateNotifications,
} from "../acp/acp-live-notifications";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

const sessionId = "session-antigravity-mcp";

function replaySingleActivity(frames: Record<string, unknown>[]): AppServerThreadActivityEntry {
  const normalizer = new AcpSessionReplayNormalizer({ antigravity: true });
  frames.forEach((update, index) => {
    normalizer.apply({ sessionId, update, receivedAt: 1000 + index });
  });
  const activities = normalizer.replay().entries.filter(
    (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
  );
  expect(activities).toHaveLength(1);
  return activities[0]!;
}

const subToolName = fc.stringMatching(/^[a-z][a-z0-9_]{2,28}$/);
const toolSummary = fc.option(
  fc.stringMatching(/^[A-Z][a-zA-Z0-9 ,()-]{3,52}[a-zA-Z0-9)]$/),
  { nil: undefined },
);
const toolArgs = fc.dictionary(
  fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,12}$/),
  fc.oneof(
    fc.stringMatching(/^[a-zA-Z0-9 _.:/-]{1,24}$/),
    fc.integer({ min: 0, max: 1000 }),
    fc.boolean(),
  ),
  { minKeys: 1, maxKeys: 4 },
);

function expectedMcpLabel(name: string, summary: string | undefined): string {
  if (!summary) {
    return name;
  }
  return summary.toLowerCase().includes(name.toLowerCase())
    ? summary
    : `${name}: ${summary}`;
}

describe("Antigravity MCP tool reporting", () => {
  it("unwraps mcp_pwragent_call_pwragent_tool in both replayed and live transcripts", () => {
    fc.assert(
      fc.property(subToolName, toolSummary, toolArgs, (targetTool, summary, args) => {
        const rawInput = {
          toolName: targetTool,
          arguments: args,
          ...(summary ? { toolSummary: summary } : {}),
        };
        const frames = [
          {
            sessionUpdate: "tool_call",
            toolCallId: "call_1",
            name: "mcp_pwragent_call_pwragent_tool",
            kind: "other",
            title: "Run mcp_pwragent_call_pwragent_tool",
            status: "in_progress",
            rawInput,
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "call_1",
            name: "mcp_pwragent_call_pwragent_tool",
            kind: "other",
            title: "Run mcp_pwragent_call_pwragent_tool",
            status: "completed",
            rawInput,
          },
        ];

        const label = expectedMcpLabel(targetTool, summary);
        const expectedInvocation = `${targetTool}\n${JSON.stringify(args, null, 2)}`;

        const replayed = replaySingleActivity(frames);
        expect(replayed.summary).toBe(label);
        expect(replayed.summary).not.toContain("mcp_pwragent_call_pwragent_tool");
        expect(replayed.details[0]).toMatchObject({
          label,
          command: {
            displayCommand: expectedInvocation,
            rawCommand: targetTool,
            source: "tool",
          },
        });

        const resolver = new AcpLiveToolUpdateResolver();
        let lastNotification: Record<string, unknown> | undefined;
        for (const update of frames) {
          const resolved = resolver.resolve({
            backendId: "acp:antigravity",
            threadId: sessionId,
            turnId: "turn-1",
            update,
          });
          if (!resolved) continue;
          const [notification] = acpToolUpdateNotifications({
            backendId: "acp:antigravity",
            threadId: sessionId,
            turnId: "turn-1",
            update: resolved,
          });
          if (notification) lastNotification = notification as unknown as Record<string, unknown>;
        }

        const item = (lastNotification?.params as { item: Record<string, unknown> } | undefined)?.item;
        expect(item).toMatchObject({
          toolName: targetTool,
          commandToolName: targetTool,
          commandSource: "tool",
          command: expectedInvocation,
          commandActions: [{ type: "unknown", name: label }],
        });
      }),
    );
  });

  it("unwraps mcp_pwragent_call_mcp_tool and direct mcp_pwragent_* tools", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("gateway", "direct"),
        subToolName,
        toolSummary,
        toolArgs,
        (mode, targetTool, summary, args) => {
          fc.pre(targetTool !== "call_pwragent_tool" && targetTool !== "call_mcp_tool");
          const outerName = mode === "gateway"
            ? "mcp_pwragent_call_mcp_tool"
            : `mcp_pwragent_${targetTool}`;
          const rawInput = mode === "gateway"
            ? {
                connectionId: "linear",
                toolName: targetTool,
                schemaRevision: "rev-1",
                arguments: args,
                ...(summary ? { toolSummary: summary } : {}),
              }
            : {
                ...args,
                ...(summary ? { toolSummary: summary } : {}),
              };
          const frames = [
            {
              sessionUpdate: "tool_call",
              toolCallId: "call_2",
              name: outerName,
              kind: "other",
              title: `Run ${outerName}`,
              status: "in_progress",
            },
            {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_2",
              name: outerName,
              kind: "other",
              title: `Run ${outerName}`,
              status: "completed",
              rawInput,
            },
          ];

          const label = expectedMcpLabel(targetTool, summary);
          const replayed = replaySingleActivity(frames);
          expect(replayed.summary).toBe(label);
          expect(replayed.details[0]?.label).toBe(label);
          expect(replayed.details[0]?.command?.rawCommand).toBe(targetTool);
          expect(replayed.details[0]?.command?.source).toBe("tool");
          expect(replayed.details[0]?.command?.displayCommand).toContain(targetTool);
        },
      ),
    );
  });

  it("reproduces the Antigravity update_review_item call_pwragent_tool counterexample", () => {
    const rawInput = {
      arguments: {
        id: "review-1",
        itemId: "finding-4",
        note: "Fixed mixed passive and error sets.",
        status: "addressed",
      },
      toolName: "update_review_item",
      toolSummary: "Settle finding 4 (nonWorkingLabel mixed sets)",
    };
    const replayed = replaySingleActivity([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_12049052803246590927",
        name: "mcp_pwragent_call_pwragent_tool",
        kind: "other",
        title: "Run mcp_pwragent_call_pwragent_tool",
        status: "in_progress",
        rawInput,
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_12049052803246590927",
        name: "mcp_pwragent_call_pwragent_tool",
        kind: "other",
        title: "Run mcp_pwragent_call_pwragent_tool",
        status: "completed",
        rawInput,
      },
    ]);

    expect(replayed.summary).toBe("update_review_item: Settle finding 4 (nonWorkingLabel mixed sets)");
    expect(replayed.details[0]?.command).toEqual({
      displayCommand: `update_review_item\n${JSON.stringify(rawInput.arguments, null, 2)}`,
      rawCommand: "update_review_item",
      source: "tool",
      output: undefined,
      exitCode: undefined,
    });
  });

  it("upgrades a sparse opening direct mcp_pwragent_* call when toolSummary arrives on update", () => {
    const replayed = replaySingleActivity([
      {
        sessionUpdate: "tool_call",
        toolCallId: "call_direct_sparse",
        name: "mcp_pwragent_tool_search",
        kind: "other",
        title: "Run mcp_pwragent_tool_search",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_direct_sparse",
        name: "mcp_pwragent_tool_search",
        kind: "other",
        title: "Run mcp_pwragent_tool_search",
        status: "completed",
        rawInput: {
          query: "review",
          toolSummary: "Search PwrAgent review tools",
        },
      },
    ]);

    expect(replayed.summary).toBe("tool_search: Search PwrAgent review tools");
    expect(replayed.details[0]?.label).toBe("tool_search: Search PwrAgent review tools");
    expect(replayed.details[0]?.command?.rawCommand).toBe("tool_search");
  });
});
