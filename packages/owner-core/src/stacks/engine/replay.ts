import { branchRef, isOid, StackGit } from "./git";
import type { Patch, StackStep } from "./types";

const lines = (text: string) => text.trim().split("\n").filter(Boolean);

async function patches(git: StackGit, range: string, leftOnly = false): Promise<Patch[]> {
  // Nearby upstream edits change context lines, even when Git preserves the
  // layer's additions and removals. Hash stable patch IDs of the edits alone.
  const diff = await git.output([
    "log", "--format=medium", "--patch", "--binary", "--no-renames", "--no-ext-diff",
    "--no-textconv", "--no-color", "--unified=0", "--inter-hunk-context=0", ...(leftOnly ? ["--left-only"] : []), range, "--",
  ]);
  return lines(await git.output(["patch-id", "--stable"], diff)).map(line => {
    const [id, commit] = line.trim().split(" ");
    if (!isOid(id) || !isOid(commit)) throw new Error("Unexpected git patch-id output");
    return { id, commit };
  });
}

async function prove(git: StackGit, step: StackStep, newTip: string): Promise<NonNullable<StackStep["proof"]>> {
  const before = await patches(git, `${step.oldBase}..${step.oldTip}`);
  const after = await patches(git, `${step.newBase}..${newTip}`);
  const remaining = new Map<string, number>();
  for (const patch of after) remaining.set(patch.id, (remaining.get(patch.id) ?? 0) + 1);
  const dropped: Patch[] = [];
  for (const patch of before) {
    const count = remaining.get(patch.id) ?? 0;
    if (count === 0) dropped.push(patch);
    else remaining.set(patch.id, count - 1);
  }
  if ([...remaining.values()].some(count => count > 0)) {
    throw new Error(`Replay changed the patches on ${step.branch}`);
  }
  if (dropped.length) {
    const upstream = new Set((await patches(git, `${step.newBase}...${step.oldBase}`, true)).map(patch => patch.id));
    if (dropped.some(patch => !upstream.has(patch.id))) {
      throw new Error(`Replay lost a patch on ${step.branch}`);
    }
  }
  return { preserved: after.length, dropped };
}

async function replay(git: StackGit, ref: string, base: string, oldTip: string, onto: string) {
  return git.run(["replay", "--ref-action=print", `--ref=${ref}`, `--onto=${onto}`, `${base}..${oldTip}`]);
}

function replayTip(stdout: string, ref: string): string {
  const fields = stdout.trim().split(/\s+/);
  if (fields[0] !== "update" || fields[1] !== ref || !isOid(fields[2]) || fields.length !== 4) {
    throw new Error("Unexpected git replay output");
  }
  return fields[2];
}

async function forecast(git: StackGit, ref: string, commits: string[], oldBase: string, newBase: string) {
  let base = oldBase;
  let onto = newBase;
  for (const commit of commits) {
    const merge = await git.run(["merge-tree", "--write-tree", "--name-only", "-z", `--merge-base=${base}`, onto, commit]);
    if (merge.exitCode === 1) {
      const [, ...details] = merge.stdout.split("\0");
      const end = details.indexOf("");
      const files = end < 0 ? details : details.slice(0, end);
      if (files.length) return { commit, files };
    }
    if (merge.exitCode !== 0) throw new Error(merge.stderr.trim() || "Cannot locate replay conflict");
    const next = await replay(git, ref, base, commit, onto);
    if (next.exitCode !== 0) throw new Error(next.stderr.trim() || "Cannot forecast the next replay step");
    if (next.stdout.trim()) onto = replayTip(next.stdout, ref);
    base = commit;
  }
  throw new Error("git replay stopped without a reproducible conflict");
}

export async function replayStep(git: StackGit, step: StackStep): Promise<StackStep> {
  const { branch, oldBase, oldTip, newBase } = step;
  if (!isOid(oldBase) || !await git.ancestor(oldBase, oldTip)) {
    throw new Error(`The recorded base of ${branch} is outside its history`);
  }
  const range = `${oldBase}..${oldTip}`;
  if (await git.output(["rev-list", "--max-count=1", "--merges", range])) {
    throw new Error(`Restack requires linear history on ${branch}`);
  }
  const ref = branchRef(branch);
  let newTip = newBase;
  if (oldBase !== oldTip && oldBase !== newBase) {
    await git.requireReplayWithoutSigning();
    const result = await replay(git, ref, oldBase, oldTip, newBase);
    if (result.exitCode === 1) {
      const commits = lines(await git.output(["rev-list", "--reverse", range]));
      return { ...step, conflict: await forecast(git, ref, commits, oldBase, newBase) };
    }
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Git replay failed");
    if (result.stdout.trim()) newTip = replayTip(result.stdout, ref);
  } else if (oldBase === newBase) {
    newTip = oldTip;
  }
  if (!await git.ancestor(newBase, newTip)) throw new Error(`Replay did not put ${branch} on ${step.parent}`);
  return { ...step, newTip, proof: await prove(git, step, newTip) };
}
