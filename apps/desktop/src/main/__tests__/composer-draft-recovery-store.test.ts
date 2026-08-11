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

const RECOVERABLE_NON_TEXT_VARIANTS: Array<{
  label: string;
  patch: Partial<ComposerDraftSnapshotRecord>;
}> = [
  {
    label: "editor document",
    patch: {
      editorDocument: {
        type: "doc",
        content: [{ type: "paragraph" }],
      },
    },
  },
  {
    label: "skill tokens",
    patch: {
      skillTokens: [
        {
          id: "skill-1",
          index: 0,
          name: "review",
          path: "/skills/review",
        },
      ],
    },
  },
  {
    label: "image attachments",
    patch: {
      imageAttachments: [
        {
          id: "image-1",
          name: "reference.png",
          size: 128,
          type: "image/png",
          url: "data:image/png;base64,abc",
        },
      ],
    },
  },
  {
    label: "file attachments",
    patch: {
      fileAttachments: [
        {
          id: "file-1",
          label: "notes.txt",
          path: "/tmp/notes.txt",
        },
      ],
    },
  },
];

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
        backend: "grok",
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

  it("keeps one row when editor text grows with the plain-text prefix", () => {
    ["I like", "I like ", "I like dogs"].forEach((text, index) => {
      store.save({
        draft: buildDraft({
          scopeKey: "thread:codex:typing",
          threadId: "typing",
          text,
          editorDocument: buildEditorDocument(text),
          updatedAt: 1000 + index,
          contentHash: `editor-${text}`,
        }),
        recordHistory: true,
      });
    });

    expect(journalTexts()).toEqual(["I like dogs"]);
  });

  it.each(RECOVERABLE_NON_TEXT_VARIANTS)(
    "keeps equal-text rows with different $label",
    ({ patch }) => {
      const text = "A long draft whose non-text recovery state changed.";
      store.save({
        draft: buildDraft({
          ...patch,
          scopeKey: "thread:codex:typing",
          threadId: "typing",
          text,
          contentHash: "",
        }),
        recordHistory: true,
      });
      store.save({
        draft: buildDraft({
          scopeKey: "thread:codex:typing",
          threadId: "typing",
          text,
          contentHash: "",
        }),
        recordHistory: true,
      });

      expect(journalTexts()).toEqual([text, text]);
    },
  );

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
    rows: Array<{
      payload?: string;
      scopeKey?: string;
      status?: string;
      text: string;
    }>,
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
        row.payload ?? JSON.stringify({ scopeKey, status, text: row.text }),
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

  it("collapses legacy editor documents that differ only by prefix text", () => {
    seedLegacyJournal([
      {
        payload: JSON.stringify({
          editorDocument: buildEditorDocument("I like"),
          text: "I like",
        }),
        text: "I like",
      },
      {
        payload: JSON.stringify({
          editorDocument: buildEditorDocument("I like dogs"),
          text: "I like dogs",
        }),
        text: "I like dogs",
      },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual([
      { status: "unsent", text: "I like dogs" },
    ]);
  });

  it("collapses abandoned prefix chains too", () => {
    seedLegacyJournal([
      { status: "abandoned", text: "A recoverable" },
      { status: "abandoned", text: "A recoverable abandoned draft" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    expect(readJournal()).toEqual([
      { status: "abandoned", text: "A recoverable abandoned draft" },
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

  it.each(RECOVERABLE_NON_TEXT_VARIANTS)(
    "does not collapse legacy prefixes across different $label",
    ({ patch }) => {
      seedLegacyJournal([
        {
          payload: JSON.stringify({
            ...patch,
            text: "I like dogs",
          }),
          text: "I like dogs",
        },
        { text: "I like dogs and cats" },
      ]);

      stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

      const payloads = stateDb.raw
        .prepare(
          "SELECT payload FROM composer_draft_journal ORDER BY updated_at, id",
        )
        .all() as Array<{ payload: string }>;
      expect(payloads).toHaveLength(2);
    },
  );

  it("leaves malformed payloads alone and does not collapse across them", () => {
    seedLegacyJournal([
      { text: "I like" },
      { payload: "{not-json", text: "malformed" },
      { text: "I like dogs" },
    ]);

    stateDb.cleanupExpired(NOW_FOR_COLLAPSE);

    const payloads = (
      stateDb.raw
        .prepare(
          "SELECT payload FROM composer_draft_journal ORDER BY updated_at, id",
        )
        .all() as Array<{ payload: string }>
    ).map((row) => row.payload);
    expect(payloads).toHaveLength(3);
    expect(payloads[0]).toContain('"text":"I like"');
    expect(payloads[1]).toBe("{not-json");
    expect(payloads[2]).toContain('"text":"I like dogs"');
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

function buildEditorDocument(
  text: string,
): ComposerDraftSnapshotRecord["editorDocument"] {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}
