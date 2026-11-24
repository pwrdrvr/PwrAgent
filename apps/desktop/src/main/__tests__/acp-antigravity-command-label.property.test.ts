import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { formatCommandLabel } from "@pwragent/shared/command-action-labels";
import { acpToolUpdateNotifications } from "../acp/acp-live-notifications";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";

// Antigravity's `run_command` sends the whole script as the tool call's
// `title`, the same script as `rawInput.CommandLine`, and a sentence about
// it as `rawInput.toolSummary`. The replayed transcript used the title as
// the row's heading, so a 20-line inline script filled the transcript as
// wrapped bold prose.

const sessionId = "session-antigravity";

/** The frames Antigravity 1.x sent for one `run_command`. */
function runCommandFrames(params: {
  id: string;
  commandLine: string;
  toolSummary?: string;
  output: string;
}): Record<string, unknown>[] {
  const rawInput = {
    CommandLine: params.commandLine,
    WaitMsBeforeAsync: 5000,
    ...(params.toolSummary ? { toolSummary: params.toolSummary } : {}),
  };
  const base = {
    toolCallId: params.id,
    name: "run_command",
    args: rawInput,
    kind: "execute",
    title: params.commandLine,
    rawInput,
  };
  return [
    { sessionUpdate: "tool_call", ...base, status: "in_progress" },
    {
      sessionUpdate: "tool_call_update",
      ...base,
      status: "completed",
      rawOutput: { output: params.output, exit_code: 0 },
      content: [{ type: "content", content: { type: "text", text: params.output } }],
    },
  ];
}

function replayActivity(frames: Record<string, unknown>[]): AppServerThreadActivityEntry {
  const normalizer = new AcpSessionReplayNormalizer();
  frames.forEach((update, index) => {
    normalizer.apply({ sessionId, update, receivedAt: 1000 + index });
  });
  const activities = normalizer.replay().entries.filter(
    (entry): entry is AppServerThreadActivityEntry => entry.type === "activity",
  );
  expect(activities).toHaveLength(1);
  return activities[0]!;
}

const commandLine = fc
  .array(
    fc.stringMatching(/^[a-zA-Z0-9_$=."/ -]{1,90}$/).filter((line) => line.trim().length > 0),
    { minLength: 1, maxLength: 12 },
  )
  // The reader trims a field, as Antigravity's own scripts already are.
  .map((lines) => lines.join("\n").trim())
  .filter((script) => script.length > 0);
const toolSummary = fc.option(
  fc.stringMatching(/^[A-Z][a-zA-Z0-9 ,()-]{3,58}[a-zA-Z0-9)]$/),
  { nil: undefined },
);

describe("Antigravity run_command rows", () => {
  it("label a replayed command with one short line and keep the script in its details", () => {
    fc.assert(
      fc.property(commandLine, toolSummary, (script, summary) => {
        const entry = replayActivity(runCommandFrames({
          id: "call_1",
          commandLine: script,
          toolSummary: summary,
          output: "Command exited with code 0.\n",
        }));
        const detail = entry.details[0]!;
        const expectedLabel = summary ?? formatCommandLabel(script);

        expect(entry.summary).toBe(expectedLabel);
        expect(detail.label).toBe(expectedLabel);
        expect(detail.kind).toBe("command");
        expect(detail.command?.rawCommand).toBe(script);
        expect(detail.command?.displayCommand).toBe(script);
        expect(detail.command?.source).not.toBe("tool");
      }),
    );
  });

  it("send the live row the script as a shell command and its summary as the action name", () => {
    fc.assert(
      fc.property(commandLine, toolSummary, (script, summary) => {
        const [, completed] = runCommandFrames({
          id: "call_1",
          commandLine: script,
          toolSummary: summary,
          output: "ok\n",
        });
        const notifications = acpToolUpdateNotifications({
          backendId: "acp:antigravity",
          threadId: sessionId,
          update: completed!,
        });
        expect(notifications).toHaveLength(1);
        const item = (notifications[0]!.params as { item: Record<string, unknown> }).item;

        expect(item.command).toBe(script);
        expect(item.commandSource).toBe("shell");
        expect(item.commandActions ?? []).toEqual(
          summary ? [{ type: "unknown", name: summary }] : [],
        );
      }),
    );
  });
});
