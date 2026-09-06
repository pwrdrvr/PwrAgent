import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { buildOwnedComposerScopeKey } from "@pwragent/shared";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllEnvs();
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ComposerDraftRecoveryStore", () => {
  it("budgets known-owner migration as one transaction and zero writes on repeat", async () => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    stateDb.close();
    stateDb = StateDb.open(path.join(tempDir, "state.db"));
    store = new ComposerDraftRecoveryStore(stateDb);
    for (let index = 0; index < 3; index += 1) {
      store.save({ draft: buildDraft({ scopeKey: `thread:codex:thread-${index}`, threadId: `thread-${index}`, text: `Draft ${index}`,
        threadOwner: { backend: "codex", threadId: `thread-${index}`, target: { scope: "remote", instanceId: `peer-${index}` } },
      }), recordHistory: true });
    }
    const { result, writes } = await measureSqliteWrites(() => store.migrateKnownOwnerScopes());
    expect(result).toBe(3);
    expectSqliteWriteBudget({ scenario: "composer-owner-scope-migration", writes,
      note: "One startup transaction migrates three latest drafts and three proven-owner journal records; less than 0.1 MB once, zero additional MB/day after migration" });
    const repeat = await measureSqliteWrites(() => store.migrateKnownOwnerScopes());
    expect(repeat.result).toBe(0);
    expectSqliteWriteBudget({ scenario: "composer-owner-scope-migration-repeat", writes: repeat.writes,
      note: "Repeated startup migration performs no commits after known scopes are qualified; 0 MB/day" });
  });

  it("migrates only proven owners and leaves unassigned and foreign history intact", () => {
    const owner = { backend: "codex" as const, threadId: "same", target: { scope: "remote" as const, instanceId: "peer" } };
    const legacy = "thread:codex:same";
    store.recordHistory(buildDraft({ scopeKey: legacy, text: "Unassigned older history", threadId: "same", contentHash: "unassigned" }));
    store.recordHistory(buildDraft({ scopeKey: legacy, text: "Other owner's history", threadId: "same", contentHash: "foreign",
      threadOwner: { ...owner, target: { scope: "local" } } }));
    store.save({ draft: buildDraft({ scopeKey: legacy, text: "Known owner's latest", threadId: "same", contentHash: "known", threadOwner: owner }), recordHistory: true });
    store.save({ draft: buildDraft({ scopeKey: "thread:codex:unknown", text: "Never infer local ownership", threadId: "unknown" }) });
    expect(store.migrateKnownOwnerScopes()).toBe(1);
    const owned = buildOwnedComposerScopeKey(owner);
    expect(store.listLatest().map((draft) => draft.scopeKey).sort()).toEqual([owned, "thread:codex:unknown"].sort());
    expect(store.listCandidates({ scopeKey: owned, includeSent: true }).map((draft) => draft.text)).toEqual(["Known owner's latest"]);
    expect(store.listCandidates({ scopeKey: legacy, includeSent: true }).map((draft) => draft.text).sort())
      .toEqual(["Unassigned older history", "Other owner's history"].sort());
    expect(store.migrateKnownOwnerScopes()).toBe(0);
  });

  it("does not resurrect a legacy draft over a cleared owner scope", () => {
    const owner = { backend: "codex" as const, threadId: "same", target: { scope: "local" as const } };
    store.save({ draft: buildDraft({ scopeKey: "thread:codex:same", threadOwner: owner, text: "Older draft" }) });
    store.recordHistory(buildDraft({ scopeKey: buildOwnedComposerScopeKey(owner), threadOwner: owner, text: "Already sent", status: "sent" }));
    expect(store.migrateKnownOwnerScopes()).toBe(0);
    expect(store.listLatest()[0]?.scopeKey).toBe("thread:codex:same");
  });
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

  describe("composer_draft_latest retention", () => {
    // 2026-08-11, so the arithmetic below reads as real dates rather than
    // offsets from an implicit now.
    const NOW = 1_786_500_000_000;
    const DAY = 24 * 60 * 60 * 1000;

    const countLatest = (): number =>
      (
        stateDb.raw
          .prepare("SELECT COUNT(*) AS n FROM composer_draft_latest")
          .get() as { n: number }
      ).n;

    const seedDraft = (scope: string, updatedAt: number): void => {
      store.save({
        draft: buildDraft({
          scopeKey: `thread:codex:${scope}`,
          threadId: scope,
          text: `draft ${scope}`,
          updatedAt,
        }),
      });
    };

    it("keeps drafts edited this year", () => {
      // The bar for discarding current work is high on purpose: a draft five
      // months old is still something someone meant to send.
      seedDraft("today", NOW);
      seedDraft("last-month", NOW - 30 * DAY);
      seedDraft("five-months-ago", NOW - 150 * DAY);

      stateDb.cleanupExpired(NOW);

      expect(countLatest()).toBe(3);
    });

    it("ages out a draft nobody has edited in half a year", () => {
      seedDraft("recent", NOW - DAY);
      seedDraft("ancient", NOW - 200 * DAY);

      stateDb.cleanupExpired(NOW);

      expect(store.listLatest().map((draft) => draft.scopeKey)).toEqual([
        "thread:codex:recent",
      ]);
    });

    it("does not delete a draft when its thread is archived", () => {
      // Archiving is reversible here (`restoreThread` / the Codex
      // `thread/unarchive` method), so discarding unsent text at archive time
      // would destroy data at the one moment the operator can undo the action
      // that caused it. An archived thread's draft stays put and stays
      // reachable through the composer's recovery cycle; it only leaves once
      // it has gone stale like any other. Staleness is also the only signal
      // available here — the state layer cannot tell a deleted thread from an
      // archived one, and an archived thread cannot be opened, so its draft
      // is exactly what this ages out.
      seedDraft("archived-thread", NOW - DAY);

      stateDb.cleanupExpired(NOW);

      expect(
        store
          .listCandidates({ includeSent: true, limit: 20 })
          .map((candidate) => candidate.scopeKey),
      ).toContain("thread:codex:archived-thread");
    });

    it("does not evict on volume alone", () => {
      // A row cap would fire here and a staleness sweep must not: these are
      // all current drafts, and destroying the oldest of them because there
      // are many is exactly the data loss this sweep exists to avoid.
      for (let index = 0; index < 600; index += 1) {
        seedDraft(`thread-${index}`, NOW - index * 1000);
      }

      stateDb.cleanupExpired(NOW);

      expect(countLatest()).toBe(600);
    });
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

// Fixed and recent, so the 30-day retention sweep running in the same
// `cleanupExpired` pass never removes these fixtures out from under the
// assertions.
const NOW_FOR_COLLAPSE = 1_786_500_000_000;

describe("journal prefix-chain collapse on the GC pass", () => {
  /**
   * Seeds rows in the shape the buggy runtime left behind — one per word —
   * directly, since the point is what an EXISTING profile already carries.
   */
  const seedLegacyJournal = (
    rows: Array<{ scopeKey?: string; status?: string; text: string }>,
  ): void => {
    const insert = stateDb.raw.prepare(
      `INSERT INTO composer_draft_journal(
         scope_key, scope_kind, status, content_hash, char_count,
         created_at, updated_at, payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    rows.forEach((row, index) => {
      const scopeKey = row.scopeKey ?? "thread:codex:t1";
      const status = row.status ?? "unsent";
      insert.run(
        scopeKey,
        "thread",
        status,
        `hash-${scopeKey}-${status}-${row.text}`,
        row.text.length,
        1,
        NOW_FOR_COLLAPSE + index,
        JSON.stringify({ scopeKey, status, text: row.text }),
      );
    });
  };

  const readJournal = (): Array<{ status: string; text: string }> =>
    (
      stateDb.raw
        .prepare(
          "SELECT status, payload FROM composer_draft_journal ORDER BY scope_key, updated_at, id",
        )
        .all() as { payload: string; status: string }[]
    ).map((row) => ({
      status: row.status,
      text: (JSON.parse(row.payload) as { text: string }).text,
    }));

  it("collapses a chain left by the old per-word behaviour", () => {
    seedLegacyJournal([
      { text: "I" },
      { text: "I like" },
      { text: "I like dogs" },
      { text: "I like dogs and" },
      { text: "I like dogs and cats" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    // The longest text survives — nothing an operator wrote is lost, only the
    // redundant snapshots of the way there.
    expect(readJournal()).toEqual([
      { status: "unsent", text: "I like dogs and cats" },
    ]);
  });

  it("keeps a genuine branch rather than collapsing everything", () => {
    seedLegacyJournal([
      { text: "I like dogs" },
      { text: "I like cats" },
      { text: "I like cats a lot" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual([
      { status: "unsent", text: "I like dogs" },
      { status: "unsent", text: "I like cats a lot" },
    ]);
  });

  it("never reads or deletes sent rows", () => {
    // `sent` entries record what was actually submitted. The runtime's
    // previous-row query excludes them, so this must too.
    seedLegacyJournal([
      { status: "sent", text: "I like dogs" },
      { text: "I like dogs" },
      { text: "I like dogs and cats" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual([
      { status: "sent", text: "I like dogs" },
      { status: "unsent", text: "I like dogs and cats" },
    ]);
  });

  it("does not let one scope absorb another", () => {
    seedLegacyJournal([
      { scopeKey: "thread:codex:a", text: "Shared" },
      { scopeKey: "thread:codex:b", text: "Shared prefix continues" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual([
      { status: "unsent", text: "Shared" },
      { status: "unsent", text: "Shared prefix continues" },
    ]);
  });

  it("deletes nothing on a second pass", () => {
    // Idempotency is what makes running this every GC pass safe rather than
    // needing a one-shot schema migration to gate it.
    seedLegacyJournal([{ text: "I like" }, { text: "I like dogs" }]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);
    const afterFirst = readJournal();
    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual(afterFirst);
    expect(afterFirst).toEqual([{ status: "unsent", text: "I like dogs" }]);
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
