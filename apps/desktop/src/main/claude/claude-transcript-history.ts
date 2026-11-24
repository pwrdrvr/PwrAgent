import { open, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import type {
  AppServerReadThreadRequest,
  AppServerThreadEntry,
  AppServerThreadReviewEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared/contracts/normalized-app-server";
import { continuesClaudeActivityGroup } from "./claude-activity";

export type ClaudeTruncationRecord = {
  type: "pwragent_truncation";
  id: string;
  beforeEntryId: string;
  createdAt: number;
};

export type ClaudeTruncationUndoRecord = {
  type: "pwragent_truncation_undo";
  truncationId: string;
  createdAt: number;
};

/** Settles every entry of the turn, including revisions saved after it. */
export type ClaudeTurnEndRecord = {
  type: "pwragent_turn_end";
  turnId: string;
  status: NonNullable<AppServerThreadTurnMetadata["status"]>;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
};

export type ClaudeHistoryLine = AppServerThreadEntry | ClaudeTruncationRecord | ClaudeTruncationUndoRecord | ClaudeTurnEndRecord;

type PageRequest = Pick<AppServerReadThreadRequest, "before" | "includeTurns" | "limit">;
type RawPage = { entries: AppServerThreadEntry[]; hasOlderEntries: boolean; unresolvedCursor?: boolean };

/** Indexed view of the PwrAgent transcript, in first-observed entry order. */
export class ClaudeTranscriptHistory {
  private readonly rows: AppServerThreadEntry[] = [];
  private readonly positionById = new Map<string, number>();
  private readonly firstByTurn = new Map<string, number>();
  private firstUnbound = Infinity;
  private readonly turnEnds = new Map<string, AppServerThreadTurnMetadata>();
  private readonly reviews = new Map<string, AppServerThreadReviewEntry>();
  private readonly pendingReviewIds = new Set<string>();
  private readonly unfinishedReviewsByTurn = new Map<string, Set<string>>();
  private latestReview: AppServerThreadReviewEntry | undefined;

  apply(lines: readonly ClaudeHistoryLine[]): void {
    // Undo requires replay from the beginning. The file reader ensures the
    // batch is complete when it contains an undo.
    const undone = new Set<string>();
    for (const line of lines) {
      if (line.type === "pwragent_truncation_undo") undone.add(line.truncationId);
    }
    let reindexTurns = false;
    for (const line of lines) {
      if (line.type === "pwragent_truncation_undo") continue;
      if (line.type === "pwragent_turn_end") {
        this.turnEnds.set(line.turnId, {
          id: line.turnId, status: line.status,
          ...(line.startedAt !== undefined ? { startedAt: line.startedAt } : {}),
          ...(line.completedAt !== undefined ? { completedAt: line.completedAt } : {}),
        });
        if (line.status !== "in_progress") {
          for (const id of this.unfinishedReviewsByTurn.get(line.turnId) ?? []) this.pendingReviewIds.add(id);
          this.unfinishedReviewsByTurn.delete(line.turnId);
        }
        continue;
      }
      if (line.type === "pwragent_truncation") {
        if (undone.has(line.id)) continue;
        const start = this.positionById.get(line.beforeEntryId);
        if (start === undefined) continue;
        while (this.rows.length > start) {
          const entry = this.rows.pop()!;
          this.positionById.delete(entry.id);
          this.removeReview(entry.id);
          const turnId = entry.turn?.id;
          if (turnId && this.firstByTurn.get(turnId) === this.rows.length) {
            this.firstByTurn.delete(turnId);
          }
        }
        if (this.firstUnbound >= start) this.firstUnbound = Infinity;
        continue;
      }
      const index = this.positionById.get(line.id);
      if (index === undefined) {
        this.recordPosition(line, this.rows.length);
        this.positionById.set(line.id, this.rows.length);
        this.rows.push(line);
      } else {
        reindexTurns ||= this.rows[index]?.turn?.id !== line.turn?.id;
        this.rows[index] = line;
      }
      this.removeReview(line.id);
      if (line.type === "review") {
        this.reviews.set(line.id, line);
        const turn = this.settle(line).turn;
        if (turn?.status === "in_progress") {
          const waiting = this.unfinishedReviewsByTurn.get(turn.id) ?? new Set<string>();
          waiting.add(line.id);
          this.unfinishedReviewsByTurn.set(turn.id, waiting);
        } else {
          this.pendingReviewIds.add(line.id);
        }
        if (line.reviewer?.backend === "claude" && line.output
          && (this.positionById.get(line.id) ?? -1) >= (this.positionById.get(this.latestReview?.id ?? "") ?? -1)) {
          this.latestReview = line;
        }
      }
    }
    if (reindexTurns) {
      this.firstByTurn.clear();
      this.firstUnbound = Infinity;
      this.rows.forEach((row, index) => this.recordPosition(row, index));
    }
    if (this.latestReview && this.reviews.get(this.latestReview.id) !== this.latestReview) {
      this.latestReview = this.findLastReview();
    }
  }

  private recordPosition(entry: AppServerThreadEntry, index: number): void {
    const turnId = entry.turn?.id;
    if (!turnId) this.firstUnbound = Math.min(this.firstUnbound, index);
    else if (!this.firstByTurn.has(turnId)) this.firstByTurn.set(turnId, index);
  }

  private removeReview(id: string): void {
    const review = this.reviews.get(id);
    if (!review) return;
    this.reviews.delete(id);
    this.pendingReviewIds.delete(id);
    if (!review.turn?.id) return;
    const waiting = this.unfinishedReviewsByTurn.get(review.turn.id);
    waiting?.delete(id);
    if (waiting?.size === 0) this.unfinishedReviewsByTurn.delete(review.turn.id);
  }

  private settle<T extends AppServerThreadEntry>(row: T): T {
    const turnId = row.turn?.id;
    const turn = turnId ? this.turnEnds.get(turnId) : undefined;
    return turn ? { ...row, turn } : row;
  }

  entries(): AppServerThreadEntry[] {
    return this.rows.map((row) => this.settle(row));
  }

  lastReview(excludeId: string): AppServerThreadReviewEntry | undefined {
    const latest = this.latestReview?.id === excludeId ? this.findLastReview(excludeId) : this.latestReview;
    return latest && this.settle(latest);
  }

  private findLastReview(excludeId?: string): AppServerThreadReviewEntry | undefined {
    let latest: AppServerThreadReviewEntry | undefined;
    let position = -1;
    for (const entry of this.reviews.values()) {
      if (entry.id === excludeId || entry.reviewer?.backend !== "claude" || !entry.output) continue;
      const next = this.positionById.get(entry.id)!;
      if (next > position) {
        position = next;
        latest = entry;
      }
    }
    return latest;
  }

  importReviews(accept: (reviews: AppServerThreadReviewEntry[]) => readonly string[] | void): void {
    if (!this.pendingReviewIds.size) return;
    const reviews = [...this.pendingReviewIds].map((id) => this.settle(this.reviews.get(id)!));
    const failed = accept(reviews);
    this.pendingReviewIds.clear();
    for (const id of failed ?? []) {
      if (this.reviews.has(id)) this.pendingReviewIds.add(id);
    }
  }

  page(request: PageRequest, live: ReadonlyMap<string, AppServerThreadEntry>): RawPage | undefined {
    if (request.includeTurns === false) return { entries: [], hasOlderEntries: false };
    const extra: AppServerThreadEntry[] = [];
    const extraPosition = new Map<string, number>();
    const extraFirstByTurn = new Map<string, number>();
    let firstUnbound = this.firstUnbound;
    for (const [id, entry] of live) {
      const storedPosition = this.positionById.get(id);
      if (storedPosition !== undefined) {
        // A normal live revision retains its turn. If a legacy entry is
        // assigned a different turn in memory, use the full replay oracle.
        if (entry.turn?.id !== this.rows[storedPosition]?.turn?.id) return undefined;
        continue;
      }
      const position = this.rows.length + extra.length;
      extraPosition.set(id, position);
      const turnId = entry.turn?.id;
      if (!turnId) firstUnbound = Math.min(firstUnbound, position);
      else if (!extraFirstByTurn.has(turnId)) extraFirstByTurn.set(turnId, position);
      extra.push(entry);
    }
    const rowAt = (index: number): AppServerThreadEntry => {
      if (index >= this.rows.length) return extra[index - this.rows.length]!;
      const row = this.rows[index]!;
      return live.get(row.id) ?? this.settle(row);
    };

    const end = request.before === undefined
      ? this.rows.length + extra.length
      : this.positionById.get(request.before) ?? extraPosition.get(request.before);
    if (end === undefined || (request.before !== undefined && end > 0
      && continuesClaudeActivityGroup(rowAt(end - 1), rowAt(end)))) {
      return { entries: [], hasOlderEntries: false, unresolvedCursor: true };
    }

    let start = 0;
    if (request.limit !== undefined) {
      const limit = Math.max(0, Math.floor(request.limit));
      if (limit === 0) start = end;
      else if (firstUnbound < end && !Number.isNaN(limit)) {
        // Legacy replays page by grouped entry count. Count from the cursor
        // while keeping the beginning of the first activity group intact.
        start = end;
        for (let groups = 0; start > 0 && groups < limit; groups++) {
          start--;
          while (start > 0 && continuesClaudeActivityGroup(rowAt(start - 1), rowAt(start))) start--;
        }
      } else if (!Number.isNaN(limit)) {
        // The shared pager selects the earliest occurrence of the last turn
        // it encounters walking back. It can start before other rows of that
        // turn, even if an outliving task interleaved with later work.
        const turns = new Set<string>();
        for (let index = end - 1; index >= 0; index--) {
          const turnId = rowAt(index).turn!.id;
          if (turns.has(turnId)) continue;
          if (turns.size >= limit) break;
          turns.add(turnId);
          if (turns.size >= limit) start = this.firstByTurn.get(turnId) ?? extraFirstByTurn.get(turnId)!;
        }
      }
    }
    const entries: AppServerThreadEntry[] = [];
    for (let index = start; index < end; index++) entries.push(rowAt(index));
    return { entries, hasOlderEntries: start > 0 };
  }
}

type HistorySnapshot = {
  stat: Stats;
  /** Byte offset after the last newline, so a torn record can finish later. */
  boundary: number;
  provisional: boolean;
  history: ClaudeTranscriptHistory;
};

// A long open thread stays warm. Older threads may be reconstructed after
// eviction. Use log bytes as a conservative size estimate for retained rows.
const CACHE_BYTES = 96 * 1024 * 1024;
const CACHE_THREADS = 12;

type PendingTranscriptRead = {
  started: boolean;
  result: Promise<ClaudeTranscriptHistory>;
};

export class ClaudeTranscriptCache {
  private readonly snapshots = new Map<string, HistorySnapshot>();
  private readonly reads = new Map<string, PendingTranscriptRead>();

  read(file: string): Promise<ClaudeTranscriptHistory> {
    const current = this.reads.get(file);
    // Only share a read whose file observation is still ahead of every caller.
    // A later caller may have begun after a write completed. Let it join the
    // next batch, which checks the file even when the cached contents are warm.
    if (current && !current.started) return current.result;
    const previous = current?.result.catch(() => undefined) ?? Promise.resolve();
    const pending: PendingTranscriptRead = {
      started: false,
      result: previous.then(() => {
        pending.started = true;
        return this.readFile(file);
      }).finally(() => {
        if (this.reads.get(file) === pending) this.reads.delete(file);
      }),
    };
    this.reads.set(file, pending);
    return pending.result;
  }

  private async readFile(file: string): Promise<ClaudeTranscriptHistory> {
    const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!handle) {
      this.snapshots.delete(file);
      return new ClaudeTranscriptHistory();
    }
    try {
      const stat = await handle.stat();
      const previous = this.snapshots.get(file);
      const sameFile = previous && stat.ino === previous.stat.ino && stat.dev === previous.stat.dev;
      if (sameFile && stat.size === previous.stat.size
        && stat.mtimeMs === previous.stat.mtimeMs && stat.ctimeMs === previous.stat.ctimeMs) {
        this.remember(file, previous);
        return previous.history;
      }
      const appended = sameFile && stat.size > previous.stat.size && !previous.provisional ? previous : undefined;
      let start = appended?.boundary ?? 0;
      let raw = await readTranscriptSuffix(handle, start, stat.size);
      let history = appended?.history;
      if (history && raw.lines.some((line) => line.type === "pwragent_truncation_undo")) {
        start = 0;
        raw = await readTranscriptSuffix(handle, start, stat.size);
        history = undefined;
      }
      history ??= new ClaudeTranscriptHistory();
      history.apply(raw.lines);
      this.remember(file, {
        stat, history, boundary: start + raw.boundary, provisional: raw.provisional,
      });
      return history;
    } finally {
      await handle.close();
    }
  }

  private remember(file: string, snapshot: HistorySnapshot): void {
    this.snapshots.delete(file);
    this.snapshots.set(file, snapshot);
    let bytes = 0;
    for (const item of this.snapshots.values()) bytes += item.stat.size;
    for (const [oldest, item] of this.snapshots) {
      if (this.snapshots.size <= 1 || (this.snapshots.size <= CACHE_THREADS && bytes <= CACHE_BYTES)) break;
      this.snapshots.delete(oldest);
      bytes -= item.stat.size;
    }
  }
}

async function readTranscriptSuffix(handle: FileHandle, start: number, end: number) {
  const buffer = Buffer.allocUnsafe(end - start);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const content = buffer.subarray(0, offset);
  const boundary = content.lastIndexOf(0x0a) + 1;
  const lines: ClaudeHistoryLine[] = [];
  const rows = content.toString("utf8").split("\n");
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    if (!row) continue;
    try {
      lines.push(JSON.parse(row) as ClaudeHistoryLine);
      if (index === rows.length - 1) return { lines, boundary, provisional: true };
    } catch {
      // A torn final record may complete on a later read. A malformed
      // complete line is skipped just as it is by the full history reader.
    }
  }
  return { lines, boundary, provisional: false };
}
