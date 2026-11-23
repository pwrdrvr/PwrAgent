import type { GitRunner, RefMove, WorktreeFollow } from "./types";

export const branchRef = (branch: string) => `refs/heads/${branch}`;
export const isOid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

function overlaps(dirty: string[], diff: string): string[] {
  const changed = diff.split("\0").filter(Boolean);
  return dirty.filter(file => changed.some(name => name === file || name.startsWith(file + "/") || file.startsWith(name + "/")));
}

export class StackGit {
  constructor(readonly runner: GitRunner, readonly cwd: string) {}

  run(args: string[], stdin?: string, cwd = this.cwd) {
    return this.runner.run(cwd, args, stdin === undefined ? undefined : { stdin });
  }

  async output(args: string[], stdin?: string, cwd?: string): Promise<string> {
    const result = await this.run(args, stdin, cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.exitCode}`);
    return result.stdout;
  }

  async tip(branch: string): Promise<string | null> {
    const ref = branchRef(branch);
    await this.output(["check-ref-format", ref]);
    const result = await this.run(["show-ref", "--verify", "--hash", ref]);
    if (result.exitCode === 128 && !result.stdout) {
      const exists = await this.run(["show-ref", "--exists", ref]);
      if (exists.exitCode === 2) return null;
    }
    const oid = result.stdout.trim();
    if (result.exitCode !== 0 || !isOid(oid)) throw new Error(result.stderr.trim() || `Cannot read ${ref}`);
    return oid;
  }

  async ancestor(base: string, tip: string): Promise<boolean> {
    const result = await this.run(["merge-base", "--is-ancestor", base, tip]);
    if (result.exitCode > 1 || result.exitCode < 0) throw new Error(result.stderr.trim() || "Cannot verify ancestry");
    return result.exitCode === 0;
  }

  async transaction(moves: RefMove[], expected: Record<string, string | null>, creates: string[] = []) {
    for (const branch of new Set([...Object.keys(expected), ...moves.map(move => move.branch)])) {
      await this.output(["check-ref-format", branchRef(branch)]);
    }
    const oids = [...Object.values(expected), ...moves.flatMap(({ old, next }) => [old, next])];
    if (oids.some(oid => oid !== null && (typeof oid !== "string" || !isOid(oid)))) {
      throw new Error("Invalid stack transaction object ID");
    }
    const updates = new Set(moves.map(move => move.branch));
    const commands = [
      ...creates,
      ...Object.entries(expected).flatMap(([branch, oid]) => updates.has(branch) ? [] : [`verify ${branchRef(branch)} ${oid ?? ""}`.trimEnd()]),
      ...moves.map(({ branch, old, next }) => {
        const ref = branchRef(branch);
        if (next === null) return `delete ${ref} ${old}`;
        return old === null ? `create ${ref} ${next}` : `update ${ref} ${next} ${old}`;
      }),
    ];
    if (commands.length) {
      const output = await this.output(["update-ref", "--stdin"], ["start", ...commands, "prepare", "commit", ""].join("\n"));
      if (!output.split(/\r?\n/).includes("commit: ok")) {
        throw new Error("Git did not confirm the stack ref transaction");
      }
    }
  }

  async worktrees(moves: RefMove[]): Promise<WorktreeFollow[]> {
    if (!moves.length) return [];
    const byBranch = new Map(moves.map(move => [branchRef(move.branch), move]));
    const records = (await this.output(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
    const follows: WorktreeFollow[] = [];
    let movedBranchNames: Set<string> | undefined;
    for (const record of records) {
      const fields = record.split("\0");
      if (!fields[0].startsWith("worktree ")) continue;
      const path = fields[0].slice("worktree ".length);
      const ref = fields.find(field => field.startsWith("branch "))?.slice(7);
      if (fields.includes("detached") && !fields.some(field => field.startsWith("prunable"))) {
        // A paused rebase can be detached with neither REBASE_HEAD nor
        // unmerged index entries. Git resolves these paths per worktree.
        const markers = await this.output(["rev-parse", "--path-format=absolute",
          "--git-path", "rebase-merge/head-name", "--git-path", "rebase-apply/head-name"], undefined, path);
        for (const marker of markers.trimEnd().split(/\r?\n/)) {
          const state = await this.run(["hash-object", "--no-filters", "--", marker], undefined, path);
          if (state.exitCode !== 0) continue;
          // The marker contains the full branch ref and a newline. Compare
          // blobs through Git so no file access or platform path parsing
          // escapes the portable runner.
          if (!movedBranchNames) {
            movedBranchNames = new Set();
            for (const name of byBranch.keys()) {
              movedBranchNames.add((await this.output(["hash-object", "--stdin"], name + "\n")).trim());
            }
          }
          if (movedBranchNames.has(state.stdout.trim())) {
            throw new Error(`Finish the paused rebase in ${path} before changing stack refs`);
          }
        }
      }
      const move = ref && byBranch.get(ref);
      if (!move || move.old === null) continue;
      if (move.next === null) throw new Error(`Switch away from ${move.branch} in ${path} before undoing its creation`);
      follows.push({ branch: move.branch, path, old: move.old, next: move.next });
    }
    return follows;
  }

  async requireMembership(moves: RefMove[], recorded: WorktreeFollow[]): Promise<void> {
    const key = ({ branch, path }: WorktreeFollow) => JSON.stringify([branch, path]);
    const current = await this.worktrees(moves);
    const keys = new Set(recorded.map(key));
    if (current.length !== recorded.length || current.some(worktree => !keys.has(key(worktree)))) {
      throw new Error("Stack worktree membership changed during the ref update");
    }
  }

  private async requireCheckout(path: string, branch: string): Promise<void> {
    const common = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const [directory, prefix] = (await this.output([...common, "--show-prefix"], undefined, path)).split(/\r?\n/);
    const expected = (await this.output(common)).trimEnd();
    const head = await this.run(["symbolic-ref", "-q", "HEAD"], undefined, path);
    if (directory !== expected || prefix !== "" || head.exitCode !== 0 || head.stdout.trim() !== branchRef(branch)) {
      throw new Error(`Stack worktree is missing or changed: ${path}`);
    }
  }

  async requireReplayWithoutSigning(cwd = this.cwd): Promise<void> {
    const signing = await this.run(["config", "--type=bool", "--get", "commit.gpgSign"], undefined, cwd);
    if (signing.exitCode === 0 && signing.stdout.trim() === "true") {
      throw new Error(`Stack replay cannot sign commits. Commit signing is enabled in ${cwd}.`);
    }
    if (signing.exitCode !== 0 && signing.exitCode !== 1) {
      throw new Error(signing.stderr.trim() || "Cannot read commit signing settings");
    }
  }

  async dirtyOverlap(follows: WorktreeFollow[]): Promise<{ path: string; files: string[] }[]> {
    const blocked = [];
    for (const follow of follows) {
      const { branch, path, old, next } = follow;
      await this.requireCheckout(path, branch);
      const porcelain = await this.output(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored", "--no-renames", "--ignore-submodules=none"], undefined, path);
      const dirty = porcelain.split("\0").filter(Boolean).map(entry => entry.slice(3).replace(/\/$/, ""));
      const diff = await this.output(["diff-tree", "-r", "--name-only", "--no-renames", "-z", old, next]);
      const files = overlaps(dirty, diff);
      if (files.length) blocked.push({ path, files });
      else await this.output(["read-tree", "--dry-run", "-m", "-u", old, next], undefined, path);
    }
    return blocked;
  }

  async follow(worktree: WorktreeFollow): Promise<void> {
    const { branch, path, old, next } = worktree;
    await this.requireCheckout(path, branch);
    if (await this.tip(branch) !== next) {
      throw new Error(`Worktree changed while applying the stack: ${path}`);
    }
    const ignored = await this.output(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], undefined, path);
    const diff = await this.output(["diff-tree", "-r", "--name-only", "--no-renames", "-z", old, next]);
    const files = overlaps(ignored.split("\0").filter(Boolean), diff);
    if (files.length) throw new Error(`Ignored local files in ${path}: ${files.join(", ")}`);
    await this.output(["read-tree", "-m", "-u", old, next], undefined, path);
  }
}
