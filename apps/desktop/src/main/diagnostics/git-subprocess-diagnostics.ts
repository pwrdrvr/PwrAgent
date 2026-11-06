import { createHmac, randomBytes } from "node:crypto";

export type GitSubprocessPurpose =
  | "unspecified" | "directory-enrichment" | "directory-status"
  | "working-state" | "pr-remotes" | "pr-discovery" | "pr-local-head";

type Command =
  | "remote-list" | "remote-url" | "remote-other" | "refs" | "symbolic-ref"
  | "rev-parse" | "worktree-list" | "worktree-other" | "status" | "diff"
  | "config" | "log" | "rev-list" | "merge-base" | "other" | "ssh-config";
type Counts = { started: number; succeeded: number; failed: number; durationMs: number };
type Identity = { directory?: string; commonDirectory?: string; sshHost?: string };
type Row = Counts & { command: Command; purpose: GitSubprocessPurpose; directoryId: string; commonDirectoryId?: string; sshHostId?: string };
type Bucket = { startMs: number; totals: Counts; overflow: Counts; rows: Map<string, Row> };
const counts = (): Counts => ({ started: 0, succeeded: 0, failed: 0, durationMs: 0 });

/** No raw argv, paths, hosts, output, environment, stacks, timers or writes.
 * IDs are salted per process and cannot correlate captures across restarts.
 * Start counts are spawn attempts, durations are wall time, never child CPU.
 */
export class GitSubprocessDiagnostics {
  private readonly salt = randomBytes(32);
  private readonly buckets = new Map<number, Bucket>();
  private readonly commonDirectories = new Map<string, string>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {}

  private id(value: string): string {
    return createHmac("sha256", this.salt).update(value).digest("hex").slice(0, 16);
  }

  /** Called only by metadata readers that already know the relationship. */
  observeRepository(directory: string, commonDirectory?: string): void {
    this.commonDirectories.delete(directory);
    if (!commonDirectory) return;
    this.commonDirectories.set(directory, commonDirectory);
    if (this.commonDirectories.size > 512) this.commonDirectories.delete(this.commonDirectories.keys().next().value!);
  }

  private prune(start: number): void {
    for (const key of this.buckets.keys()) {
      if (key <= start - 120_000 || key > start) this.buckets.delete(key);
    }
  }

  start(command: Command, purpose: GitSubprocessPurpose, identity?: Identity): (failed: boolean) => void {
    const started = this.monotonicNow();
    const directoryId = identity?.directory ? this.id(identity.directory) : "none";
    const common = identity?.commonDirectory ?? (identity?.directory && this.commonDirectories.get(identity.directory));
    const commonDirectoryId = common ? this.id(common) : undefined;
    const sshHostId = identity?.sshHost ? this.id(identity.sshHost) : undefined;
    const record = (delta: Counts) => {
      const startMs = Math.floor(this.now() / 2_000) * 2_000;
      let bucket = this.buckets.get(startMs);
      if (!bucket) {
        this.prune(startMs);
        bucket = { startMs, totals: counts(), overflow: counts(), rows: new Map() };
        this.buckets.set(startMs, bucket);
      }
      const key = `${command}:${purpose}:${directoryId}:${commonDirectoryId ?? ""}:${sshHostId ?? ""}`;
      let row = bucket.rows.get(key);
      if (!row && bucket.rows.size < 32) {
        row = { command, purpose, directoryId, commonDirectoryId, sshHostId, ...counts() };
        bucket.rows.set(key, row);
      }
      for (const name of Object.keys(delta) as Array<keyof Counts>) {
        bucket.totals[name] += delta[name];
        (row ?? bucket.overflow)[name] += delta[name];
      }
    };
    record({ ...counts(), started: 1 });
    return (failed) => record({ started: 0, succeeded: failed ? 0 : 1, failed: failed ? 1 : 0, durationMs: Math.max(0, this.monotonicNow() - started) });
  }

  startGit(cwd: string, args: string[], purpose: GitSubprocessPurpose = "unspecified"): (failed: boolean) => void {
    const verb = args[0];
    const command: Command = verb === "remote"
      ? args.length === 1 ? "remote-list" : args[1] === "get-url" ? "remote-url" : "remote-other"
      : verb === "worktree" ? args[1] === "list" ? "worktree-list" : "worktree-other"
      : verb === "for-each-ref" ? "refs"
      : verb === "symbolic-ref" || verb === "rev-parse" || verb === "status" || verb === "diff"
        || verb === "config" || verb === "log" || verb === "rev-list" || verb === "merge-base" ? verb : "other";
    return this.start(command, purpose, { directory: cwd });
  }

  snapshot() {
    const capturedAtMs = this.now();
    this.prune(Math.floor(capturedAtMs / 2_000) * 2_000);
    return {
      schemaVersion: 1, capturedAtMs, bucketMs: 2_000, retentionMs: 120_000, rowsPerBucket: 32,
      buckets: [...this.buckets.values()].map((bucket) => ({
        startMs: bucket.startMs, totals: { ...bucket.totals }, overflow: { ...bucket.overflow },
        rows: [...bucket.rows.values()].map((row) => ({ ...row })),
      })),
    };
  }
}

export const gitSubprocessDiagnostics = new GitSubprocessDiagnostics();
