// Pins the a11y gate's sub-agent seeder against the real overlay schema.
//
// `e2e/fixtures/sub-agent-state-seeding.ts` writes the `threads` table by
// hand, so it encodes three assumptions the app could change underneath it:
// the storage key format, the overlay payload shape, and the fact that
// `subAgents` lives in that payload at all. If any drifts, the seeder writes a
// row nothing reads — and the a11y block it feeds would keep passing while
// auditing a strip that never rendered. That failure is silent by
// construction, which is exactly why it gets a test rather than a comment.
//
// It lives here rather than beside the fixture because `e2e/` is Playwright's;
// this needs vitest and a real sqlite file, and it costs no Electron launch.
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import {
  buildAuditSubAgents,
  seedThreadSubAgents,
} from "../../../e2e/fixtures/sub-agent-state-seeding";

function freshStateDbPath(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sub-agent-seed-"));
  const dbPath = path.join(dir, "state.db");
  // Create the schema the way the app does, then close over the same file.
  StateDb.open(dbPath, { profileName: "default" });
  return dbPath;
}

function openStore(dbPath: string): SqliteOverlayStore {
  return new SqliteOverlayStore(StateDb.open(dbPath, { profileName: "default" }));
}

describe("seedThreadSubAgents", () => {
  it("reaches the overlay store when the thread has no row yet", async () => {
    // The a11y block seeds immediately after launch, before opening the
    // thread, so this is the path it actually takes.
    const dbPath = freshStateDbPath();

    seedThreadSubAgents({
      stateDbPath: dbPath,
      subAgents: buildAuditSubAgents(),
      threadId: "thread-smoke",
    });

    const state = await openStore(dbPath).getThreadOverlayState({
      backend: "codex",
      threadId: "thread-smoke",
    });

    expect(state?.subAgents).toHaveLength(4);
    expect(state?.subAgents?.map((subAgent) => subAgent.status)).toEqual([
      "running",
      "blocked",
      "failed",
      "failed",
    ]);
  });

  it("preserves existing overlay state when a row already exists", async () => {
    const dbPath = freshStateDbPath();
    await openStore(dbPath).setThreadReaction({
      backend: "codex",
      threadId: "thread-two",
      emoji: "🔥",
      present: true,
    });

    seedThreadSubAgents({
      stateDbPath: dbPath,
      subAgents: buildAuditSubAgents().slice(0, 2),
      threadId: "thread-two",
    });

    const state = await openStore(dbPath).getThreadOverlayState({
      backend: "codex",
      threadId: "thread-two",
    });

    expect(state?.subAgents).toHaveLength(2);
    // Merging, not clobbering — the seeder must not wipe what the app wrote.
    expect(state?.reactions).toEqual(["🔥"]);
  });

  it("covers every row branch the strip can render", () => {
    // The audit is only worth its runtime if the seed exercises each visual
    // state. Drop one and the gate silently stops auditing that contrast pair.
    const statuses = buildAuditSubAgents().map((subAgent) => subAgent.status);

    expect(new Set(statuses)).toEqual(new Set(["running", "blocked", "failed"]));
    // Two failures, because the bulk-dismiss control only renders past one.
    expect(statuses.filter((status) => status === "failed")).toHaveLength(2);
    // Stop only renders for a running sub-agent carrying a monitor turn.
    const running = buildAuditSubAgents().find(
      (subAgent) => subAgent.status === "running",
    );
    expect(running?.monitorThreadId).toBeTruthy();
    expect(running?.monitorTurnId).toBeTruthy();
  });
});
