import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { reviewedMergeBase } from "./review-range.mjs";

const runFile = promisify(execFile);
const SHA_PATTERN = /^[0-9a-f]{40}$/;

async function git(cwd, args, signal) {
  const { stdout } = await runFile("git", ["-C", cwd, ...args], {
    signal,
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function assertCommitSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`Expected a 40-character Git commit SHA for ${label}.`);
  }
}

async function listCommitRange(source, range, signal) {
  const out = await git(source, ["rev-list", range], signal);
  return out ? out.split("\n").filter(Boolean) : [];
}

async function commitParents(source, commits, signal) {
  const map = new Map();
  if (!commits.length) return map;
  const out = await git(source, ["rev-list", "--no-walk=unsorted", "--parents", ...commits], signal);
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [commit, ...parents] = line.split(" ");
    if (commit) map.set(commit, parents);
  }
  return map;
}

/**
 * Compute the exact minimal set of commits needed to preserve base, head,
 * mergeBase, and their exact merge-base relationship without carrying commits
 * before mergeBase, after base/head, or on unrelated branches.
 */
async function collectMinimalSnapshotCommits(source, base, head, mergeBase, signal) {
  const [baseCommits, headCommits] = await Promise.all([
    listCommitRange(source, `${mergeBase}..${base}`, signal),
    listCommitRange(source, `${mergeBase}..${head}`, signal),
  ]);
  const commitSet = new Set([mergeBase, ...baseCommits, ...headCommits]);
  const shallow = new Set();

  // Handle merge commits inside mergeBase..base or mergeBase..head whose
  // secondary parent is a strict ancestor of mergeBase: marking the merge
  // commit itself shallow would sever its path to mergeBase, so pull only the
  // ancestry path between that parent and mergeBase and shallow the parent.
  for (;;) {
    const parentsMap = await commitParents(source, [...commitSet], signal);
    const additions = [];
    shallow.clear();
    for (const commit of commitSet) {
      const parents = parentsMap.get(commit) ?? [];
      if (!parents.length) continue;
      const missing = parents.filter((parent) => !commitSet.has(parent));
      if (!missing.length) continue;
      const present = parents.filter((parent) => commitSet.has(parent));
      if (!present.length) {
        shallow.add(commit);
        continue;
      }
      for (const parent of missing) {
        additions.push(parent);
        const pathOut = await git(
          source,
          ["rev-list", "--ancestry-path", `${parent}..${mergeBase}`],
          signal,
        ).catch(() => "");
        if (pathOut) {
          for (const sha of pathOut.split("\n").filter(Boolean)) additions.push(sha);
        }
      }
    }
    let grew = false;
    for (const sha of additions) {
      if (!commitSet.has(sha)) {
        commitSet.add(sha);
        grew = true;
      }
    }
    if (!grew) break;
  }

  return { commits: [...commitSet], shallow: [...shallow].sort() };
}

function packMinimalObjects(source, workspace, commits, signal) {
  return new Promise((resolve, reject) => {
    const packDir = path.join(workspace, ".git", "objects", "pack");
    fs.mkdirSync(packDir, { recursive: true });
    const revList = spawn(
      "git",
      ["-C", source, "rev-list", "--no-walk=unsorted", "--objects", ...commits],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const packObjects = spawn(
      "git",
      ["-C", source, "pack-objects", "--quiet", path.join(packDir, "snapshot")],
      { stdio: ["pipe", "ignore", "pipe"] },
    );

    let revErr = "";
    let packErr = "";
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        revList.kill("SIGKILL");
        packObjects.kill("SIGKILL");
        reject(err);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(signal.reason ?? new Error("Snapshot packing aborted."));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    revList.stderr.on("data", (chunk) => { revErr += chunk.toString("utf8"); });
    packObjects.stderr.on("data", (chunk) => { packErr += chunk.toString("utf8"); });
    revList.on("error", finish);
    packObjects.on("error", finish);
    packObjects.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") finish(err);
    });
    revList.stdout.pipe(packObjects.stdin);

    let revCode;
    let packCode;
    const checkDone = () => {
      if (revCode === undefined || packCode === undefined) return;
      if (revCode !== 0) {
        finish(new Error(`git rev-list failed (${revCode}): ${revErr.trim()}`));
      } else if (packCode !== 0) {
        finish(new Error(`git pack-objects failed (${packCode}): ${packErr.trim()}`));
      } else {
        finish(null);
      }
    };
    revList.on("close", (code) => { revCode = code; checkDone(); });
    packObjects.on("close", (code) => { packCode = code; checkDone(); });
  });
}

/** Create a repository with its own Git directory and no inherited template hooks. */
export async function initReviewWorkspace(parent, name, signal) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(parent, `${name}-`)));
  try {
    await git(workspace, ["init", "--quiet", "--template="], signal);
    await git(workspace, ["config", "core.logAllRefUpdates", "false"], signal);
    await git(workspace, ["config", "gc.auto", "0"], signal);
    return workspace;
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function checkoutReviewSnapshot({
  source,
  parent,
  name,
  base,
  head,
  mergeBase,
  remoteUrl = "https://github.com/pwrdrvr/PwrAgent.git",
  blockRemotes = true,
  signal,
}) {
  assertCommitSha(base, "baseCommit");
  assertCommitSha(head, "headCommit");
  assertCommitSha(mergeBase, "mergeBaseCommit");

  const { commits, shallow } = await collectMinimalSnapshotCommits(source, base, head, mergeBase, signal);
  const workspace = await initReviewWorkspace(parent, name, signal);
  try {
    if (shallow.length) {
      fs.writeFileSync(path.join(workspace, ".git", "shallow"), `${shallow.join("\n")}\n`);
    }
    await packMinimalObjects(source, workspace, commits, signal);
    await git(workspace, ["update-ref", "refs/eval/base", base], signal);
    await git(workspace, ["update-ref", "refs/eval/head", head], signal);
    await git(workspace, ["update-ref", "refs/eval/merge-base", mergeBase], signal);
    if (reviewedMergeBase(workspace, base, head) !== mergeBase) {
      throw new Error("Reviewer workspace does not contain the pinned Git range.");
    }
    // The owner's PR guard validates the attached PR against Git remotes.
    // Keep only the public repository identity and block all transport
    // protocols so reviewer processes cannot fetch from any remote.
    if (remoteUrl) {
      await git(workspace, ["remote", "add", "origin", remoteUrl], signal);
    }
    if (blockRemotes) {
      await git(workspace, ["config", "protocol.allow", "never"], signal);
    }
    await git(workspace, ["switch", "--quiet", "--detach", head], signal);
    // Pre-create the review-objects ref dir so sandboxed owners can protect
    // pinned SHAs without needing write access to .git/config or the tree.
    fs.mkdirSync(path.join(workspace, ".git", "refs", "pwragent", "review-objects"), { recursive: true });
    // Remove any reflogs or transient Git metadata that could reference source paths.
    fs.rmSync(path.join(workspace, ".git", "logs"), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, ".git", "FETCH_HEAD"), { force: true });
    fs.rmSync(path.join(workspace, ".git", "ORIG_HEAD"), { force: true });
    return workspace;
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function writePinnedReviewPatch(workspace, mergeBase, head, signal) {
  const name = "pwragent-eval-review.patch";
  const { stdout } = await runFile(
    "git",
    ["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--no-color", mergeBase, head, "--"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, signal, timeout: 60_000 },
  );
  signal?.throwIfAborted();
  fs.writeFileSync(path.join(workspace, name), stdout, { flag: "wx" });
  const info = path.join(workspace, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(path.join(info, "exclude"), `\n/${name}\n`);
  return name;
}
