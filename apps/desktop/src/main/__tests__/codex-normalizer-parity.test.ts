/**
 * Codex KTD-P3 parity gate (B2a) — the de-risk for the Phase-B Codex swap.
 *
 * Proves that the kit's Codex normalization reconstructs the SAME transcript the
 * in-tree path renders today, on a real captured Codex turn:
 *
 *   OLD (today): codex `thread/read` result → `extractThreadReplayFromReadResult`
 *                → AppServerThreadReplay
 *   NEW (kit):   the turn's live notifications → `normalizeNotification`
 *                (@pwrdrvr/agent-client) → reduceNormalizedThread →
 *                normalizedThreadToReplay → AppServerThreadReplay
 *
 * Same neutral reducer + adapter as the ACP gate (they're backend-agnostic).
 * Fixture is a redacted real Codex turn from the smoke eval
 * (fixtures/codex-transcripts/codex-thread-1.json: 64 notifications — 6 items,
 * 39 message deltas, full turn lifecycle — plus the matching thread/read).
 *
 * Increment 1: establish the gate + surface the first divergences (the Codex
 * normalization is ~4,650 LOC, so expect a reconciliation tail like ACP had).
 * The comparison is intentionally scoped to the transcript essentials first.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeNotification } from "@pwrdrvr/agent-client";
import type { NormalizedThreadEvent } from "@pwrdrvr/agent-core";
import type { AppServerThreadReplay } from "@pwragent/shared";
import { extractThreadReplayFromReadResult } from "../codex-app-server/client";
import { reduceNormalizedThread } from "../acp/normalized-thread-reducer";
import { normalizedThreadToReplay } from "../acp/normalized-thread-to-replay";

type CodexFixture = {
  notifications: Array<{ method: string; params: unknown }>;
  readThread: unknown;
};

function loadFixture(name: string): CodexFixture {
  const dir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/codex-transcripts",
  );
  return JSON.parse(readFileSync(path.join(dir, name), "utf8")) as CodexFixture;
}

/** NEW path: live notifications → kit normalize → reduce → adapt. */
function runKit(fixture: CodexFixture): AppServerThreadReplay {
  const events: NormalizedThreadEvent[] = [];
  for (const n of fixture.notifications) {
    const event = normalizeNotification(n.method, n.params);
    if (event) events.push(event);
  }
  return normalizedThreadToReplay(reduceNormalizedThread(events, "codex-thread"));
}

/** OLD path: codex thread/read result → in-tree extractor. */
function runInTree(fixture: CodexFixture): AppServerThreadReplay {
  return extractThreadReplayFromReadResult(fixture.readThread);
}

/**
 * Assistant-side transcript essentials, ids/timestamps stripped. We compare the
 * AGENT output, not user messages: the kit's normalizer emits assistant content
 * from the live stream, while the in-tree `thread/read` snapshot also carries
 * the user turn (which, in the kit architecture, the ChatThreadController adds —
 * not the normalizer). Same controller-vs-normalizer boundary as the ACP gate.
 */
function canon(replay: AppServerThreadReplay): unknown {
  return {
    assistantMessages: replay.messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text),
    lastAssistantMessage: replay.lastAssistantMessage,
    threadStatus: replay.threadStatus,
  };
}

describe("Codex KTD-P3 parity (B2a)", () => {
  it("real Codex turn — message transcript matches (read result vs kit replay)", () => {
    const fixture = loadFixture("codex-thread-1.json");
    expect(canon(runKit(fixture))).toEqual(canon(runInTree(fixture)));
  });
});
