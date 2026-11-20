import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerThreadActivityEntry } from "@pwragent/shared";
import {
  applyProtocolActivityNotice,
  protocolActivityEntriesAtTurnEnd,
  type ProtocolActivityNotice,
  type ProtocolActivityTurnEnd,
} from "../protocol-activity-entries";

// Rule: during one turn, no protocol notice erases a notice of another kind.
// MCP startup and login status, warnings, model reroutes, and verification
// requests each keep a row in the live transcript. A completed turn defers
// every one of them into the transcript; a failed or cancelled turn keeps the
// ones that explain the ending (warnings and model routing).
//
// Oracle: the distinct notices received, built from the notifications alone.
// A repeat of the same notice (the same server, warning text, reroute pair or
// verification) updates its own row instead of adding one.

const server = fc.constantFrom("github", "linear", "figma");
const model = fc.constantFrom("gpt-6.2-sol", "gpt-6-luna", "gpt-6-mini");

const noticeArb: fc.Arbitrary<ProtocolActivityNotice> = fc.oneof(
  fc.record({
    method: fc.constant("mcpServer/startupStatus/updated" as const),
    params: fc.record(
      {
        name: server,
        status: fc.constantFrom("starting", "ready", "failed"),
        error: fc.constantFrom("timed out", "exit 1"),
      },
      { requiredKeys: ["name", "status"] },
    ),
  }),
  fc.record({
    method: fc.constant("mcpServer/oauthLogin/completed" as const),
    params: fc.record(
      { name: server, success: fc.boolean(), error: fc.constant("denied") },
      { requiredKeys: ["name", "success"] },
    ),
  }),
  fc.record({
    method: fc.constant("warning" as const),
    params: fc.record({
      // Codex sometimes prefixes the text; an empty warning is not a notice.
      message: fc.constantFrom(
        "Low disk space",
        "warning: Low disk space",
        "Model gpt-6-mini is deprecated",
        "Context window nearly full",
        "",
        "warning:   ",
      ),
    }),
  }),
  fc.record({
    method: fc.constant("turn/modelRerouted" as const),
    params: fc.record({
      turnId: fc.constant("turn-1"),
      fromModel: model,
      toModel: model,
      reason: fc.constantFrom("highRiskCyberActivity", "aFutureReason"),
    }),
  }),
  fc.record({
    method: fc.constant("turn/verificationRequested" as const),
    params: fc.record({
      turnId: fc.constant("turn-1"),
      verifications: fc.array(fc.constantFrom("trustedAccessForCyber", "aFutureCheck"), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
  }),
);

type NoticeKind = "mcp" | "warning" | "routing";

/** Distinct notices, keyed by what makes them distinct, with the text the latest one carries. */
function expectedNotices(notices: readonly ProtocolActivityNotice[]): Map<string, { kind: NoticeKind; label?: string }> {
  const expected = new Map<string, { kind: NoticeKind; label?: string }>();
  for (const notice of notices) {
    switch (notice.method) {
      case "mcpServer/startupStatus/updated": {
        const { name, status, error } = notice.params as { name: string; status: string; error?: string };
        expected.set(`live-mcp-status-${name}`, {
          kind: "mcp",
          label: error ? `MCP ${name} ${status}: ${error}` : `MCP ${name} ${status}`,
        });
        break;
      }
      case "mcpServer/oauthLogin/completed": {
        const { name, success, error } = notice.params as { name: string; success: boolean; error?: string };
        expected.set(`live-mcp-oauth-${name}`, {
          kind: "mcp",
          label: success
            ? `MCP ${name} login completed`
            : `MCP ${name} login failed${error ? `: ${error}` : ""}`,
        });
        break;
      }
      case "warning": {
        const text = String(notice.params.message).replace(/^warning:\s*/i, "").trim();
        if (text) expected.set(`warning:Warning: ${text}`, { kind: "warning" });
        break;
      }
      case "turn/modelRerouted": {
        const { fromModel, toModel } = notice.params;
        expected.set(`reroute:${fromModel}:${toModel}`, { kind: "routing" });
        break;
      }
      case "turn/verificationRequested":
        for (const verification of notice.params.verifications) {
          expected.set(`verification:${verification}`, { kind: "routing" });
        }
        break;
    }
  }
  return expected;
}

/** What the rows show: each detail by id, and each detail-less row by its summary. */
function shownNotices(entries: readonly AppServerThreadActivityEntry[]): Map<string, string> {
  const shown = new Map<string, string>();
  for (const entry of entries) {
    if (entry.details.length === 0) {
      shown.set(`warning:${entry.summary}`, entry.summary);
    }
    for (const detail of entry.details) {
      shown.set(detail.id, detail.label);
    }
  }
  return shown;
}

function expectAllShown(
  entries: readonly AppServerThreadActivityEntry[],
  expected: Map<string, { kind: NoticeKind; label?: string }>,
) {
  const shown = shownNotices(entries);
  for (const [key, notice] of expected) {
    expect(shown.has(key), `notice ${key} is missing`).toBe(true);
    if (notice.label) expect(shown.get(key)).toBe(notice.label);
  }
  // Rows render with their id as a React key and defer into the transcript by id.
  const ids = entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
}

function replay(notices: readonly ProtocolActivityNotice[], check?: (entries: readonly AppServerThreadActivityEntry[], step: number) => void) {
  let entries: readonly AppServerThreadActivityEntry[] = [];
  notices.forEach((notice, step) => {
    entries = applyProtocolActivityNotice(entries, notice, { threadId: "thread-1", now: 1_000 + step });
    check?.(entries, step);
  });
  return entries;
}

describe("pending protocol activity rows", () => {
  it("keeps every distinct notice in the live transcript and defers all of them when the turn completes", () => {
    fc.assert(
      fc.property(fc.array(noticeArb, { minLength: 1, maxLength: 16, size: "max" }), (notices) => {
        const entries = replay(notices, (live, step) => {
          expectAllShown(live, expectedNotices(notices.slice(0, step + 1)));
        });
        expectAllShown(protocolActivityEntriesAtTurnEnd(entries, "completed"), expectedNotices(notices));
      }),
    );
  });

  it("keeps the warnings and model-routing notices that explain a failed or cancelled turn", () => {
    fc.assert(
      fc.property(
        fc.array(noticeArb, { minLength: 1, maxLength: 16, size: "max" }),
        fc.constantFrom<ProtocolActivityTurnEnd>("failed", "cancelled"),
        (notices, end) => {
          const kept = protocolActivityEntriesAtTurnEnd(replay(notices), end);
          const explaining = new Map(
            [...expectedNotices(notices)].filter(([, notice]) => notice.kind !== "mcp"),
          );
          expectAllShown(kept, explaining);
          // Ambient MCP startup and login status is not why a turn ended.
          expect([...shownNotices(kept).keys()].some((key) => key.startsWith("live-mcp-"))).toBe(false);
        },
      ),
    );
  });

  it("does not erase an MCP row with a warning that arrives after it", () => {
    const entries = replay([
      { method: "mcpServer/startupStatus/updated", params: { name: "github", status: "ready" } },
      { method: "warning", params: { message: "Low disk space" } },
    ]);
    expect(entries.map((entry) => entry.summary)).toEqual([
      "MCP github ready",
      "Warning: Low disk space",
    ]);
  });

  it("does not erase a warning with a reroute that arrives after it", () => {
    const entries = replay([
      { method: "warning", params: { message: "Low disk space" } },
      {
        method: "turn/modelRerouted",
        params: { turnId: "turn-1", fromModel: "gpt-6.2-sol", toModel: "gpt-6-luna", reason: "x" },
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(protocolActivityEntriesAtTurnEnd(entries, "failed").map((entry) => entry.summary)[0])
      .toBe("Warning: Low disk space");
  });

  it("ignores an empty warning instead of clearing the rows", () => {
    const before = replay([
      { method: "mcpServer/startupStatus/updated", params: { name: "github", status: "ready" } },
    ]);
    expect(applyProtocolActivityNotice(before, { method: "warning", params: { message: "warning: " } }, {
      threadId: "thread-1",
    })).toBe(before);
  });
});
