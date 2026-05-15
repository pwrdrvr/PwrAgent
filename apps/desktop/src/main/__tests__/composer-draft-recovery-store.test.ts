import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposerDraftSnapshotRecord } from "@pwragent/shared";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: ComposerDraftRecoveryStore;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-composer-drafts-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new ComposerDraftRecoveryStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ComposerDraftRecoveryStore", () => {
  it("creates the durable draft schema at the current state DB version", () => {
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(6);
    expect(
      stateDb.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("composer_draft_latest"),
    ).toBeDefined();
    expect(
      stateDb.raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get("composer_draft_journal"),
    ).toBeDefined();
  });

  it("saves the latest unsent draft and ranks it for the current scope", () => {
    store.save({
      draft: buildDraft({
        scopeKey: "thread:codex:thread-1",
        text: "A durable draft that should survive a restart.",
      }),
      recordHistory: true,
    });

    expect(store.listLatest()).toEqual([
      expect.objectContaining({
        scopeKey: "thread:codex:thread-1",
        text: "A durable draft that should survive a restart.",
      }),
    ]);
    expect(
      store.listCandidates({
        includeSent: true,
        scopeKey: "thread:codex:thread-1",
      }),
    ).toEqual([
      expect.objectContaining({
        scopeKey: "thread:codex:thread-1",
        status: "unsent",
      }),
    ]);
  });

  it("clears latest drafts while keeping recent sent history recoverable", () => {
    const draft = buildDraft({
      scopeKey: "thread:codex:thread-1",
      status: "sent",
      text: "Recently sent text that can be recalled from a blank composer.",
    });

    store.recordHistory(draft);
    store.clear("thread:codex:thread-1");

    expect(store.listLatest()).toEqual([]);
    expect(
      store.listCandidates({
        includeSent: true,
        scopeKey: "thread:codex:thread-1",
      }),
    ).toEqual([
      expect.objectContaining({
        status: "sent",
        text: "Recently sent text that can be recalled from a blank composer.",
      }),
    ]);
    expect(
      store.listCandidates({
        scopeKey: "thread:codex:thread-1",
      }),
    ).toEqual([]);
  });
});

function buildDraft(
  patch: Partial<ComposerDraftSnapshotRecord>,
): ComposerDraftSnapshotRecord {
  const text = patch.text ?? "Example draft";
  return {
    scopeKey: "thread:codex:thread-1",
    scopeKind: "thread",
    backend: "codex",
    threadId: "thread-1",
    text,
    skillTokens: [],
    imageAttachments: [],
    status: "unsent",
    createdAt: 1,
    updatedAt: 2,
    contentHash: `hash-${text.length}-${patch.status ?? "unsent"}`,
    charCount: text.length,
    ...patch,
  };
}
