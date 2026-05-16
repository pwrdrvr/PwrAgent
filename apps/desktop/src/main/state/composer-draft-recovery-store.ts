import type {
  ComposerDraftLifecycle,
  ComposerDraftRecoveryCandidate,
  ComposerDraftSnapshotRecord,
  ListComposerDraftRecoveryCandidatesRequest,
  SaveComposerDraftRequest,
} from "@pwragent/shared";
import type { StateDb } from "./state-db.js";

type DraftLatestRow = {
  scope_key: string;
  scope_kind: string;
  status: string;
  updated_at: number;
  payload: string;
};

type DraftJournalRow = DraftLatestRow & {
  id: number;
  content_hash: string;
  char_count: number;
  created_at: number;
};

const DEFAULT_RECOVERY_LIMIT = 20;
const MAX_RECOVERY_LIMIT = 50;
const RECOVERABLE_STATUSES = new Set<ComposerDraftLifecycle>([
  "unsent",
  "abandoned",
]);

export class ComposerDraftRecoveryStore {
  constructor(private readonly stateDb: StateDb) {}

  save(request: SaveComposerDraftRequest): ComposerDraftSnapshotRecord {
    const draft = normalizeDraftRecord(request.draft);
    const db = this.stateDb.raw;

    db.transaction(() => {
      if (draft.status === "unsent") {
        db.prepare(
          `INSERT INTO composer_draft_latest(
             scope_key, scope_kind, status, updated_at, payload
           )
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(scope_key) DO UPDATE SET
             scope_kind = excluded.scope_kind,
             status = excluded.status,
             updated_at = excluded.updated_at,
             payload = excluded.payload`,
        ).run(
          draft.scopeKey,
          draft.scopeKind,
          draft.status,
          draft.updatedAt,
          JSON.stringify(draft),
        );
      } else {
        db.prepare("DELETE FROM composer_draft_latest WHERE scope_key = ?").run(
          draft.scopeKey,
        );
      }

      if (request.recordHistory) {
        this.insertJournalDraft(draft);
      }
    })();

    return draft;
  }

  recordHistory(
    draftRecord: ComposerDraftSnapshotRecord,
  ): ComposerDraftRecoveryCandidate {
    const draft = normalizeDraftRecord(draftRecord);
    return this.insertJournalDraft(draft);
  }

  clear(scopeKey: string): void {
    this.stateDb.raw
      .prepare("DELETE FROM composer_draft_latest WHERE scope_key = ?")
      .run(scopeKey);
  }

  listLatest(): ComposerDraftSnapshotRecord[] {
    const rows = this.stateDb.raw
      .prepare(
        `SELECT scope_key, scope_kind, status, updated_at, payload
         FROM composer_draft_latest
         ORDER BY updated_at DESC`,
      )
      .all() as DraftLatestRow[];

    return rows
      .map((row) => parseDraftPayload(row.payload))
      .filter((draft): draft is ComposerDraftSnapshotRecord => Boolean(draft));
  }

  listCandidates(
    request: ListComposerDraftRecoveryCandidatesRequest = {},
  ): ComposerDraftRecoveryCandidate[] {
    const limit = clampLimit(request.limit);
    const scopeKeys = getRequestedScopeKeys(request);
    const scopeKeyParams = getScopeKeyParams(scopeKeys);
    const latestLimit = Math.max(limit * 2, limit);
    const journalLimit = Math.max(limit * 4, limit);
    const latestRows =
      scopeKeys.length > 0
        ? (this.stateDb.raw
            .prepare(
              `SELECT scope_key, scope_kind, status, updated_at, payload
               FROM composer_draft_latest
               WHERE
                 (? IS NOT NULL AND scope_key = ?)
                 OR (? IS NOT NULL AND scope_key = ?)
                 OR (? IS NOT NULL AND scope_key = ?)
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(...scopeKeyParams, latestLimit) as DraftLatestRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT scope_key, scope_kind, status, updated_at, payload
               FROM composer_draft_latest
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(latestLimit) as DraftLatestRow[]);
    const journalRows =
      scopeKeys.length > 0
        ? (this.stateDb.raw
            .prepare(
              `SELECT id, scope_key, scope_kind, status, content_hash, char_count,
                      created_at, updated_at, payload
               FROM composer_draft_journal
               WHERE
                 (? IS NOT NULL AND scope_key = ?)
                 OR (? IS NOT NULL AND scope_key = ?)
                 OR (? IS NOT NULL AND scope_key = ?)
               ORDER BY updated_at DESC, id DESC
               LIMIT ?`,
            )
            .all(...scopeKeyParams, journalLimit) as DraftJournalRow[])
        : (this.stateDb.raw
            .prepare(
              `SELECT id, scope_key, scope_kind, status, content_hash, char_count,
                      created_at, updated_at, payload
               FROM composer_draft_journal
               ORDER BY updated_at DESC, id DESC
               LIMIT ?`,
            )
            .all(journalLimit) as DraftJournalRow[]);

    const candidates: ComposerDraftRecoveryCandidate[] = [];
    for (const row of latestRows) {
      const draft = parseDraftPayload(row.payload);
      if (draft) {
        candidates.push({ ...draft });
      }
    }
    for (const row of journalRows) {
      const draft = parseDraftPayload(row.payload);
      if (draft) {
        candidates.push({ ...draft, journalId: row.id });
      }
    }

    const seen = new Set<string>();
    return candidates
      .filter((candidate) => matchesRecoveryRequest(candidate, request))
      .filter((candidate) => {
        if (!isRecoverable(candidate, request.includeSent)) {
          return false;
        }
        const key = `${candidate.scopeKey}:${candidate.status}:${candidate.contentHash}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort((left, right) => {
        const leftScore = scoreCandidate(left, request);
        const rightScore = scoreCandidate(right, request);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        return right.updatedAt - left.updatedAt;
      })
      .slice(0, limit);
  }

  private insertJournalDraft(
    draft: ComposerDraftSnapshotRecord,
  ): ComposerDraftRecoveryCandidate {
    const db = this.stateDb.raw;
    const previousRow = db
      .prepare(
        `SELECT id, scope_key, scope_kind, status, content_hash, char_count,
                created_at, updated_at, payload
         FROM composer_draft_journal
         WHERE scope_key = ? AND status IN ('unsent', 'abandoned')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(draft.scopeKey) as DraftJournalRow | undefined;
    const previousDraft = previousRow
      ? parseDraftPayload(previousRow.payload)
      : undefined;
    if (shouldReplacePreviousUnsentDraft(previousDraft, draft)) {
      db.prepare(
        `DELETE FROM composer_draft_journal
         WHERE scope_key = ? AND content_hash = ? AND status = ? AND id <> ?`,
      ).run(draft.scopeKey, draft.contentHash, draft.status, previousRow!.id);
      db.prepare(
        `UPDATE composer_draft_journal
         SET scope_kind = ?,
             status = ?,
             content_hash = ?,
             char_count = ?,
             updated_at = ?,
             payload = ?
         WHERE id = ?`,
      ).run(
        draft.scopeKind,
        draft.status,
        draft.contentHash,
        draft.charCount,
        draft.updatedAt,
        JSON.stringify(draft),
        previousRow!.id,
      );
      return { ...draft, journalId: previousRow!.id };
    }

    db.prepare(
      `INSERT INTO composer_draft_journal(
         scope_key, scope_kind, status, content_hash, char_count,
         created_at, updated_at, payload
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_key, content_hash, status) DO UPDATE SET
         scope_kind = excluded.scope_kind,
         char_count = excluded.char_count,
         updated_at = excluded.updated_at,
         payload = excluded.payload`,
    ).run(
      draft.scopeKey,
      draft.scopeKind,
      draft.status,
      draft.contentHash,
      draft.charCount,
      draft.createdAt,
      draft.updatedAt,
      JSON.stringify(draft),
    );

    const row = db
      .prepare(
        `SELECT id, payload
         FROM composer_draft_journal
         WHERE scope_key = ? AND content_hash = ? AND status = ?`,
      )
      .get(draft.scopeKey, draft.contentHash, draft.status) as
      | { id: number; payload: string }
      | undefined;
    const persisted = row ? parseDraftPayload(row.payload) : draft;
    return { ...(persisted ?? draft), journalId: row?.id };
  }
}

function normalizeDraftRecord(
  draft: ComposerDraftSnapshotRecord,
): ComposerDraftSnapshotRecord {
  if (!draft || typeof draft !== "object") {
    throw new Error("Invalid composer draft record");
  }
  const now = Date.now();
  const text = typeof draft.text === "string" ? draft.text : "";
  if (!draft.scopeKey || !draft.scopeKind) {
    throw new Error("Composer draft record requires a scope");
  }
  return {
    ...draft,
    text,
    createdAt: Number.isFinite(draft.createdAt) ? draft.createdAt : now,
    updatedAt: Number.isFinite(draft.updatedAt) ? draft.updatedAt : now,
    charCount: text.length,
    contentHash: draft.contentHash || hashDraftContent(draft),
    imageAttachments: Array.isArray(draft.imageAttachments)
      ? draft.imageAttachments
      : [],
    skillTokens: Array.isArray(draft.skillTokens) ? draft.skillTokens : [],
  };
}

function parseDraftPayload(
  payload: string,
): ComposerDraftSnapshotRecord | undefined {
  try {
    const parsed = JSON.parse(payload) as ComposerDraftSnapshotRecord;
    return normalizeDraftRecord(parsed);
  } catch {
    return undefined;
  }
}

function hashDraftContent(draft: Pick<ComposerDraftSnapshotRecord, "text">): string {
  let hash = 5381;
  for (let index = 0; index < draft.text.length; index += 1) {
    hash = (hash * 33) ^ draft.text.charCodeAt(index);
  }
  return `h${(hash >>> 0).toString(36)}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RECOVERY_LIMIT;
  }
  return Math.max(1, Math.min(MAX_RECOVERY_LIMIT, Math.floor(limit)));
}

function isRecoverable(
  candidate: ComposerDraftRecoveryCandidate,
  includeSent = false,
): boolean {
  if (candidate.status === "sent") {
    return includeSent;
  }
  return RECOVERABLE_STATUSES.has(candidate.status);
}

function matchesRecoveryRequest(
  candidate: ComposerDraftRecoveryCandidate,
  request: ListComposerDraftRecoveryCandidatesRequest,
): boolean {
  if (request.backend && candidate.backend !== request.backend) {
    return false;
  }
  if (request.scopeKey && candidate.scopeKey === request.scopeKey) {
    return true;
  }
  if (request.threadId && candidate.threadId === request.threadId) {
    return true;
  }
  if (request.directoryKey && candidate.directoryKey === request.directoryKey) {
    return true;
  }
  return !request.scopeKey && !request.threadId && !request.directoryKey;
}

function getRequestedScopeKeys(
  request: ListComposerDraftRecoveryCandidatesRequest,
): string[] {
  const scopeKeys = new Set<string>();
  if (request.scopeKey) {
    scopeKeys.add(request.scopeKey);
  }
  if (request.backend && request.threadId) {
    scopeKeys.add(`thread:${request.backend}:${request.threadId}`);
  }
  if (request.directoryKey) {
    scopeKeys.add(`launchpad:${request.directoryKey}`);
  }
  return [...scopeKeys];
}

function getScopeKeyParams(scopeKeys: string[]): Array<string | null> {
  const [first = null, second = null, third = null] = scopeKeys;
  return [first, first, second, second, third, third];
}

function scoreCandidate(
  candidate: ComposerDraftRecoveryCandidate,
  request: ListComposerDraftRecoveryCandidatesRequest,
): number {
  let score = 0;
  if (request.scopeKey && candidate.scopeKey === request.scopeKey) {
    score += 100;
  }
  if (request.threadId && candidate.threadId === request.threadId) {
    score += 60;
  }
  if (request.directoryKey && candidate.directoryKey === request.directoryKey) {
    score += 40;
  }
  if (candidate.status === "unsent") {
    score += 20;
  }
  if (candidate.status === "sent") {
    score -= 10;
  }
  return score;
}

function shouldReplacePreviousUnsentDraft(
  previous: ComposerDraftSnapshotRecord | undefined,
  next: ComposerDraftSnapshotRecord,
): boolean {
  if (!previous || previous.status === "sent" || next.status === "sent") {
    return false;
  }
  if (previous.scopeKey !== next.scopeKey) {
    return false;
  }
  const previousText = previous.text.trimEnd();
  const nextText = next.text.trimEnd();
  return (
    previousText.length > 0 &&
    nextText.length > previousText.length &&
    nextText.startsWith(previousText)
  );
}
