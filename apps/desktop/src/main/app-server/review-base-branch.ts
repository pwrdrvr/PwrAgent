import type { AppServerReviewTarget } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";
import type { ReviewGitRunner } from "./review-workspace-guard";

/** Refresh a remote-tracking review base before Codex computes its merge base. */
export async function refreshReviewBaseBranch(params: {
  cwd?: string;
  executionTarget?: "local" | "remote";
  target: AppServerReviewTarget;
  runGit?: ReviewGitRunner;
}): Promise<void> {
  const cwd = params.cwd?.trim();
  if (!cwd || params.executionTarget === "remote" || params.target.type !== "baseBranch") {
    return;
  }

  const branch = params.target.branch.trim();
  if (!branch.includes("/")) return;
  const runGit = params.runGit ?? runGitCommand;
  const remotes = (await runGit(cwd, ["remote"]))
    .stdout.split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
  const remote = remotes.find((name) => branch.startsWith(`${name}/`));
  if (!remote) return;

  const remoteBranch = branch.slice(remote.length + 1);
  if (remoteBranch === "HEAD") {
    throw new Error("Review not started: select a remote branch instead of its HEAD alias.");
  }
  try {
    await runGit(cwd, ["check-ref-format", `refs/heads/${remoteBranch}`]);
    await runGit(cwd, [
      "fetch", "--no-tags", "--no-write-fetch-head", "--", remote,
      `+refs/heads/${remoteBranch}:refs/remotes/${remote}/${remoteBranch}`,
    ]);
  } catch (error) {
    throw new Error(
      `Review not started: could not refresh '${branch}'. Check the remote and retry.`,
      { cause: error },
    );
  }
}
