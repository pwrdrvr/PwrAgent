import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { reviewedMergeBase } from "./review-range.mjs";

const runFile = promisify(execFile);

async function git(cwd, args, signal) {
  const { stdout } = await runFile("git", ["-C", cwd, ...args], { signal, timeout: 60_000 });
  return stdout.trim();
}

/** Create a repository with its own Git directory and no inherited template hooks. */
export async function initReviewWorkspace(parent, name, signal) {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(parent, name + "-")));
  try {
    await git(workspace, ["init", "--quiet", "--template="], signal);
    return workspace;
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function checkoutReviewSnapshot({ source, parent, name, base, head, mergeBase, signal }) {
  const distances = await Promise.all([base, head].map((tip) =>
    git(source, ["rev-list", "--count", "--ancestry-path", `${mergeBase}..${tip}`], signal)));
  // Bound the maximum path lengths from both tips, keeping their merge base
  // reachable even when the pinned base tip has diverged from the PR.
  const depth = 1 + Math.max(...distances.map(Number));
  const workspace = await initReviewWorkspace(parent, name, signal);
  try {
    await git(workspace, [
      "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--update-shallow",
      `--depth=${depth}`, source,
      `${base}:refs/eval/base`, `${head}:refs/eval/head`, `${mergeBase}:refs/eval/merge-base`,
    ], signal);
    if (reviewedMergeBase(workspace, base, head) !== mergeBase) {
      throw new Error("Reviewer workspace does not contain the pinned Git range.");
    }
    // The owner's PR guard validates the attached PR against Git remotes.
    // Keep the public repository identity, without a remote back to the source checkout.
    await git(workspace, ["remote", "add", "origin", "https://github.com/pwrdrvr/PwrAgent.git"], signal);
    await git(workspace, ["switch", "--quiet", "--detach", head], signal);
    return workspace;
  } catch (error) {
    fs.rmSync(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function writePinnedReviewPatch(workspace, mergeBase, head, signal) {
  const name = "pwragent-eval-review.patch";
  const { stdout } = await runFile("git", ["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "--no-color",
    mergeBase, head, "--"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, signal, timeout: 60_000 });
  signal.throwIfAborted();
  fs.writeFileSync(path.join(workspace, name), stdout, { flag: "wx" });
  const info = path.join(workspace, ".git", "info");
  fs.mkdirSync(info, { recursive: true });
  fs.appendFileSync(path.join(info, "exclude"), `\n/${name}\n`);
  return name;
}
