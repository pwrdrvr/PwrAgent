/**
 * KTD-P3 lossless-replay parity (B1).
 *
 * Replays the SAME sequence of ACP `session/update` payloads through both:
 *   - PwrAgent's in-tree `AcpSessionReplayNormalizer` → `AppServerThreadReplay`
 *   - the kit's `AcpSessionNormalizer` (@pwrdrvr/agent-acp) → event stream →
 *     `reduceNormalizedThread` → `normalizedThreadToReplay` → `AppServerThreadReplay`
 *
 * …and asserts they render the same transcript. Since the kit normalizer was
 * extracted FROM the in-tree one, any divergence is drift introduced since
 * extraction — this is the gate that proves the Phase B swap is lossless before
 * we delete the in-tree path.
 *
 * Comparison is semantic: ids + timestamps legitimately differ between the two
 * pipelines (different id schemes), so `canon()` strips them and compares
 * roles/text/summary/status/steps.
 *
 * Scope (increment 1): assistant message streaming + turn lifecycle. Tool-call
 * activities, plans, files/terminals, reasoning, and titles land in follow-up
 * increments, each driven by a real captured transcript from the smoke eval.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpSessionNormalizer, defaultQuirks, type AcpAgentQuirks } from "@pwrdrvr/agent-acp";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import type { AppServerThreadReplay } from "@pwragent/shared";
import { AcpSessionReplayNormalizer } from "../acp/acp-session-normalizer";
import { reduceNormalizedThread } from "../acp/normalized-thread-reducer";
import { normalizedThreadToReplay } from "../acp/normalized-thread-to-replay";

type Update = Record<string, unknown>;

/** Feed the transcript through the in-tree normalizer. */
function runInTree(updates: Update[]): AppServerThreadReplay {
  const normalizer = new AcpSessionReplayNormalizer();
  let replay = normalizer.replay();
  updates.forEach((update, index) => {
    replay = normalizer.apply({ sessionId: "s1", update, receivedAt: 1000 + index });
  });
  return replay;
}

/** Feed the transcript through the kit normalizer + reducer + adapter. */
function runKit(updates: Update[], quirks: AcpAgentQuirks = defaultQuirks()): AppServerThreadReplay {
  const normalizer = new AcpSessionNormalizer({ quirks });
  const ctx = { threadId: "s1", turnId: "turn-1" };
  const events: NormalizedThreadEvent[] = [];
  for (const update of updates) {
    events.push(...normalizer.apply(update, ctx).events);
  }
  events.push(...normalizer.finalizeAssistantMessage(ctx));
  return normalizedThreadToReplay(reduceNormalizedThread(events, "s1"));
}

/** Strip ids/timestamps; keep the semantic transcript for comparison. */
function canon(replay: AppServerThreadReplay): unknown {
  return {
    messages: replay.messages.map((m) => ({ role: m.role, text: m.text })),
    lastUserMessage: replay.lastUserMessage,
    lastAssistantMessage: replay.lastAssistantMessage,
    threadStatus: replay.threadStatus,
    entries: replay.entries.map((entry) => {
      if (entry.type === "message") {
        return { type: "message", role: entry.role, text: entry.text };
      }
      if (entry.type === "activity") {
        // Structural parity: entry shape + activity-level status + per-detail
        // label + count. Per-detail `kind`, `path`, and `command` are KNOWN
        // field-level divergences cataloged for B2 reconciliation (the kit
        // drops `read` location paths, conflates the title into
        // `command.displayCommand`, and infers tool-kind differently). See the
        // B1 plan doc §"Cataloged divergences".
        return {
          type: "activity",
          summary: entry.summary,
          status: entry.status,
          details: entry.details.map((d) => ({ label: d.label })),
        };
      }
      if (entry.type === "plan") {
        return { type: "plan", steps: entry.steps };
      }
      return { type: entry.type };
    }),
  };
}

describe("KTD-P3 normalizer parity", () => {
  it("assistant message streaming + turn lifecycle", () => {
    const updates: Update[] = [
      { kind: "turn_started", turnId: "turn-1" },
      { kind: "agent_message_chunk", content: "Hello " },
      { kind: "agent_message_chunk", content: "world" },
      { kind: "turn_finished", turnId: "turn-1" },
    ];
    expect(canon(runKit(updates))).toEqual(canon(runInTree(updates)));
  });

  it("ACP content-block chunks (sessionUpdate + {type,text})", () => {
    const updates: Update[] = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It is " } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PwrAgent." } },
    ];
    expect(canon(runKit(updates))).toEqual(canon(runInTree(updates)));
  });

  it("read tool call (sessionUpdate + locations)", () => {
    const updates: Update[] = [
      {
        sessionUpdate: "tool_call",
        toolCallId: "read-file-1",
        kind: "read",
        title: "README.md",
        status: "completed",
        locations: [{ path: "/repo/README.md" }],
      },
    ];
    expect(canon(runKit(updates))).toEqual(canon(runInTree(updates)));
  });

  it("plan then tool call", () => {
    const updates: Update[] = [
      { kind: "plan", steps: [{ step: "Inspect files", status: "in_progress" }] },
      { kind: "tool_call", id: "tool-1", title: "Read package.json", status: "completed", path: "package.json" },
    ];
    expect(canon(runKit(updates))).toEqual(canon(runInTree(updates)));
  });

  // Real captured transcript from the smoke eval (redacted). A full Gemini
  // "build" turn: available-commands, a thought chunk, 4 tool calls + 7 updates,
  // 8 message chunks. The strongest form of the proof — structural parity on
  // real data, where the only divergences are the cataloged tool-detail fields
  // (path/command/kind), which `canon` scopes out. See the B1 plan doc.
  it("real Gemini build transcript (captured)", () => {
    const fixtureDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures/acp-transcripts",
    );
    const updates = JSON.parse(
      readFileSync(path.join(fixtureDir, "gemini-build.json"), "utf8"),
    ) as Update[];
    expect(canon(runKit(updates))).toEqual(canon(runInTree(updates)));
  });
});
