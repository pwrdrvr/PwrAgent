import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ComposerDraftSnapshotRecord } from "@pwragent/shared";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";

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
    expect(stateDb.raw.pragma("user_version", { simple: true })).toBe(
      CURRENT_STATE_DB_USER_VERSION,
    );
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

  it("does not return same-id thread drafts from a different backend", () => {
    store.recordHistory(
      buildDraft({
        backend: "acp:grok",
        scopeKey: "thread:grok:thread-1",
        status: "sent",
        text: "Grok backend draft with the same local thread id.",
      }),
    );
    store.recordHistory(
      buildDraft({
        backend: "codex",
        scopeKey: "thread:codex:thread-1",
        status: "sent",
        text: "Codex backend draft with the same local thread id.",
      }),
    );

    expect(
      store.listCandidates({
        backend: "codex",
        includeSent: true,
        threadId: "thread-1",
      }),
    ).toEqual([
      expect.objectContaining({
        backend: "codex",
        text: "Codex backend draft with the same local thread id.",
      }),
    ]);
  });

  it("queries scoped journal rows before applying the global cap", () => {
    store.recordHistory(
      buildDraft({
        contentHash: "target",
        scopeKey: "thread:codex:older-thread",
        status: "sent",
        text: "Older scoped draft that should still be recoverable.",
        threadId: "older-thread",
        updatedAt: 1,
      }),
    );
    for (let index = 0; index < 100; index += 1) {
      store.recordHistory(
        buildDraft({
          contentHash: `other-${index}`,
          scopeKey: `thread:codex:newer-thread-${index}`,
          status: "sent",
          text: `Newer draft in another thread ${index}.`,
          threadId: `newer-thread-${index}`,
          updatedAt: 100 + index,
        }),
      );
    }

    expect(
      store.listCandidates({
        backend: "codex",
        includeSent: true,
        scopeKey: "thread:codex:older-thread",
        threadId: "older-thread",
      }),
    ).toEqual([
      expect.objectContaining({
        scopeKey: "thread:codex:older-thread",
        text: "Older scoped draft that should still be recoverable.",
      }),
    ]);
  });

  it("replaces the last unsubmitted prefix draft with the longer version", () => {
    store.recordHistory(
      buildDraft({
        contentHash: "short",
        status: "abandoned",
        text: "the quick fox",
        updatedAt: 10,
      }),
    );
    store.recordHistory(
      buildDraft({
        contentHash: "long",
        status: "abandoned",
        text: "the quick fox jumped over the lazy dog",
        updatedAt: 20,
      }),
    );

    expect(
      store.listCandidates({
        scopeKey: "thread:codex:thread-1",
      }),
    ).toEqual([
      expect.objectContaining({
        contentHash: "long",
        text: "the quick fox jumped over the lazy dog",
      }),
    ]);
  });

  it("keeps sent history even when a longer unsent prompt starts with it", () => {
    store.recordHistory(
      buildDraft({
        contentHash: "sent-short",
        status: "sent",
        text: "the quick fox",
        updatedAt: 10,
      }),
    );
    store.recordHistory(
      buildDraft({
        contentHash: "unsent-long",
        status: "abandoned",
        text: "the quick fox jumped over the lazy dog",
        updatedAt: 20,
      }),
    );

    expect(
      store.listCandidates({
        includeSent: true,
        scopeKey: "thread:codex:thread-1",
      }),
    ).toEqual([
      expect.objectContaining({
        contentHash: "unsent-long",
        status: "abandoned",
        text: "the quick fox jumped over the lazy dog",
      }),
      expect.objectContaining({
        contentHash: "sent-short",
        status: "sent",
        text: "the quick fox",
      }),
    ]);
  });
});

describe("journal prefix collapse", () => {
  const type = (text: string, index: number): void => {
    store.save({
      draft: buildDraft({
        scopeKey: "thread:codex:typing",
        threadId: "typing",
        text,
        updatedAt: 1000 + index,
        // Hash the content, not its length. `composer_draft_journal` has a
        // unique index on (scope_key, content_hash, status), so a
        // length-derived hash makes two same-length drafts collide and the
        // second silently replaces the first — which would quietly hide the
        // very row this suite is counting.
        contentHash: `hash-${text}`,
        charCount: text.length,
      }),
      recordHistory: true,
    });
  };
  const journalTexts = (): string[] =>
    (
      stateDb.raw
        .prepare(
          "SELECT payload FROM composer_draft_journal WHERE scope_key = ? ORDER BY id",
        )
        .all("thread:codex:typing") as { payload: string }[]
    ).map((row) => (JSON.parse(row.payload) as { text: string }).text);

  it("keeps one row while a message is extended", () => {
    ["I like dogs", "I like dogs and cats", "I like dogs and cats and bears"]
      .forEach(type);

    expect(journalTexts()).toEqual(["I like dogs and cats and bears"]);
  });

  it("keeps one row across a space, which used to start a new one", () => {
    // The regression this exists for. Both sides of the comparison are
    // `trimEnd`ed, so the moment a space is typed the trimmed texts are equal
    // — a strict "next must be longer" check then failed and inserted a fresh
    // row. The journal grew by one row per WORD, so a sentence with fourteen
    // spaces left fifteen near-identical rows.
    ["I like", "I like ", "I like dogs"].forEach(type);

    expect(journalTexts()).toEqual(["I like dogs"]);
  });

  it("keeps one row for a whole sentence typed character by character", () => {
    const sentence = "I like dogs and cats and bears, and I have opinions.";
    for (let index = 1; index <= sentence.length; index += 1) {
      type(sentence.slice(0, index), index);
    }

    expect(journalTexts()).toEqual([sentence]);
  });

  it("starts a new row when the text stops being an extension", () => {
    // Backspacing past what was already journalled is a real branch, not a
    // continuation, and keeping it is the point of a recovery journal.
    ["I like dogs", "I like cats"].forEach(type);

    expect(journalTexts()).toEqual(["I like dogs", "I like cats"]);
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
