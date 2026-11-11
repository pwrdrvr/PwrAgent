import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import fc from "fast-check";
import type { AppServerThreadActivityDetail, AppServerThreadEntry } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import { claudeSubAgentTranscriptEntries } from "../claude/claude-subagent-transcript";

/**
 * Rule: a Claude sub-agent's transcript shows what the sub-agent did, in
 * order. Each prompt the sub-agent was given and each reply it wrote is one
 * message (a reply Claude Code saved block by block reads as one), Claude
 * Code's meta prompts and the model's thinking never show, and each tool call
 * is one row whose status is its result's: completed, failed, or still
 * running while no result has arrived. Once the sub-agent has ended, a call
 * without a result claims no outcome, and no row is left running.
 *
 * The model is the conversation itself: the steps a generated sub-agent took.
 */

type Tool = "Bash" | "Read" | "mcp__pwragent__read_thread";

type Step =
  | { kind: "prompt"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "reply"; blocks: Array<{ kind: "text"; text: string } | { kind: "thinking" }> }
  | { kind: "call"; tool: Tool; result: "ok" | "error" | "none" };

const words = fc.constantFrom("Audit limiters", "Read the file", "Found 3 throttles", "Done.", "Checking cooldowns");

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("prompt" as const), text: words }),
  fc.record({ kind: fc.constant("meta" as const), text: fc.constant("<system-reminder>internal</system-reminder>") }),
  fc.record({
    kind: fc.constant("reply" as const),
    blocks: fc.array(fc.oneof(
      fc.record({ kind: fc.constant("text" as const), text: words }),
      fc.constant({ kind: "thinking" as const }),
    ), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    kind: fc.constant("call" as const),
    tool: fc.constantFrom<Tool>("Bash", "Read", "mcp__pwragent__read_thread"),
    result: fc.constantFrom("ok" as const, "error" as const, "none" as const),
  }),
);

/** Claude Code's session file for the steps: one record per content block. */
function sessionMessages(steps: Step[]): SessionMessage[] {
  const messages: SessionMessage[] = [];
  let seq = 0;
  const base = () => ({
    uuid: `uuid-${seq++}`, session_id: "parent", parent_tool_use_id: "toolu_parent", parent_agent_id: null,
    timestamp: new Date(Date.UTC(2026, 10, 11, 12, 0, seq)).toISOString(),
  });
  steps.forEach((current, index) => {
    if (current.kind === "prompt") messages.push({ ...base(), type: "user", message: { role: "user", content: current.text } });
    if (current.kind === "meta") {
      messages.push({ ...base(), type: "user", is_meta: true, message: { role: "user", content: current.text } } as SessionMessage);
    }
    if (current.kind === "reply") {
      for (const block of current.blocks) {
        messages.push({ ...base(), type: "assistant", message: {
          id: `msg-${index}`, role: "assistant",
          content: [block.kind === "text" ? { type: "text", text: block.text } : { type: "thinking", thinking: "secret" }],
        } });
      }
    }
    if (current.kind === "call") {
      const id = `toolu_${index}`;
      const input = current.tool === "Bash" ? { command: "rg -l throttle" }
        : current.tool === "Read" ? { file_path: "/work/src/limiter.ts" } : { threadId: "t1" };
      messages.push({ ...base(), type: "assistant", message: {
        id: `msg-${index}`, role: "assistant", content: [{ type: "tool_use", id, name: current.tool, input }],
      } });
      if (current.result !== "none") {
        messages.push({ ...base(), type: "user", message: { role: "user", content: [{
          type: "tool_result", tool_use_id: id, is_error: current.result === "error",
          content: current.result === "error" ? "permission denied" : "src/limiter.ts",
        }] } });
      }
    }
  });
  return messages;
}

function expectedMessages(steps: Step[]): Array<{ role: "user" | "assistant"; text: string }> {
  return steps.flatMap((current): Array<{ role: "user" | "assistant"; text: string }> => {
    if (current.kind === "prompt") return [{ role: "user" as const, text: current.text }];
    if (current.kind !== "reply") return [];
    const text = current.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
    return text ? [{ role: "assistant" as const, text }] : [];
  });
}

/** The row detail that stands for a tool call, after consecutive rows fold. */
function callDetail(entries: AppServerThreadEntry[], id: string): AppServerThreadActivityDetail | undefined {
  return entries.flatMap((entry) => entry.type === "activity" ? entry.details : [])
    .find((detail) => detail.id === id);
}

describe("Claude sub-agent transcript", () => {
  it("shows each prompt, reply and tool call once, in order, with its result's status", () => {
    fc.assert(fc.property(fc.array(step, { maxLength: 24 }), fc.boolean(), (steps, running) => {
      const entries = claudeSubAgentTranscriptEntries(sessionMessages(steps), { running });
      const shown = entries.flatMap((entry) => entry.type === "message" ? [{ role: entry.role, text: entry.text }] : []);
      expect(shown).toEqual(expectedMessages(steps));
      expect(JSON.stringify(entries)).not.toContain("system-reminder");
      expect(JSON.stringify(entries)).not.toContain("secret");

      const calls = steps.flatMap((current, index) => current.kind === "call" ? [{ ...current, id: `toolu_${index}` }] : []);
      const detailCount = entries.flatMap((entry) => entry.type === "activity" ? entry.details : [])
        .filter((detail) => !detail.id.endsWith(":output")).length;
      expect(detailCount).toBe(calls.length);
      for (const call of calls) {
        const detail = callDetail(entries, call.id);
        expect(detail, call.id).toBeDefined();
        expect(detail?.status).toBe(call.result === "ok" ? "completed" : call.result === "error" ? "failed"
          : running ? "in_progress" : undefined);
      }
      if (!running) expect(entries.some((entry) => entry.type === "activity" && entry.status === "in_progress")).toBe(false);
      // A row folds only consecutive calls, so a message between two calls
      // keeps them in separate rows, in order.
      const order = entries.flatMap((entry) => entry.type === "activity"
        ? entry.details.filter((detail) => !detail.id.endsWith(":output")).map((detail) => detail.id)
        : []);
      expect(order).toEqual(calls.map((call) => call.id));
    }));
  });

  it("puts a command's output on its row", () => {
    const entries = claudeSubAgentTranscriptEntries(sessionMessages([{ kind: "call", tool: "Bash", result: "ok" }]), { running: false });
    expect(callDetail(entries, "toolu_0")?.command).toMatchObject({ rawCommand: "rg -l throttle", output: "src/limiter.ts" });
  });
});
