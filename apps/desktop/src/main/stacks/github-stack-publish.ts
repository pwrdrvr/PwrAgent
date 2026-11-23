import { branchRef, isOid, type StackGit } from "@pwragent/owner-core/stacks/engine/git";
import type { GhStack } from "@pwragent/shared/stacks/catalog";
import type { ForgeCiClient } from "../pr-status/forge-ci-client";
import { parseGitHubRemote } from "../pr-status/git-remote";
import { ForgeReadError, type ForgeRepository } from "../pr-status/forge-tool-contract";
import type { GithubStackPull } from "./github-stack-evidence";

type Pull = GithubStackPull;
type ReadGithub = ForgeCiClient["requestGithub"];

export async function stackPublishRemote(git: StackGit, repository: ForgeRepository): Promise<string> {
  const matches = (url: string) => {
    if (/[\r\n]/.test(url)) return false;
    const parsed = parseGitHubRemote(url);
    return parsed && `${parsed.host}/${parsed.owner}/${parsed.repo}`.toLowerCase()
      === `${repository.host}/${repository.owner}/${repository.repo}`.toLowerCase();
  };
  for (const remote of (await git.output(["remote"])).trim().split("\n")) {
    if (!/^[\w][\w.-]*$/.test(remote)) continue;
    const fetch = (await git.output(["remote", "get-url", "--all", remote])).trim();
    const push = (await git.output(["remote", "get-url", "--push", "--all", remote])).trim();
    if (matches(fetch) && matches(push)) return remote;
  }
  throw new Error("No single fetch and push destination matches the stack's GitHub repository");
}

export async function readStackPublishTarget(
  repository: ForgeRepository, stack: GhStack, index: number, number: number, request: ReadGithub, signal?: AbortSignal, observedParent?: number,
) {
  const branch = stack.branches[index]!;
  const parent = stack.branches[index - 1];
  const path = `repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const repo = `${repository.owner}/${repository.repo}`.toLowerCase();
  const get = async (n: number) => await request(repository, { path: `${path}/pulls/${n}` }, signal) as Pull;
  const child = await get(number);
  if (child.state !== "open" || child.head?.ref !== branch.branch || child.head.repo?.full_name?.toLowerCase() !== repo
    || !child.head.sha || !isOid(child.head.sha)) {
    throw new Error(`#${number} no longer has an open pull request on ${branch.branch} in this repository`);
  }
  const remoteHead = child.head.sha;
  const parentNumber = parent?.pullRequest?.number ?? observedParent;
  const parentPr = parentNumber === undefined ? undefined : await get(parentNumber);
  const merged = parentPr?.merged
    && parentPr.head?.ref === parent?.branch && parentPr.head?.repo?.full_name?.toLowerCase() === repo
    && parentPr.head?.sha && isOid(parentPr.head.sha)
    && parentPr.merge_commit_sha && isOid(parentPr.merge_commit_sha)
    ? { number: parentNumber!, head: parentPr.head.sha, commit: parentPr.merge_commit_sha }
    : undefined;
  if (child.base?.ref !== (parent?.branch ?? stack.trunk.branch) && !(merged && child.base?.ref === stack.trunk.branch)) {
    throw new Error(`#${number} changed base. Read the stack again before publishing`);
  }

  return {
    remoteHead, merged,
    parentHead: !merged ? parentPr?.head?.sha : undefined,
    async retarget() {
      if (!merged || child.base?.ref === stack.trunk.branch) return;
      signal?.throwIfAborted();
      const membership = await request(repository, { path: `${path}/stacks?pull_request=${number}` }, signal).catch((error: unknown) => {
        if (error instanceof ForgeReadError && error.code === "not_found" && !stack.id && !stack.number) return [];
        throw error;
      });
      if (!Array.isArray(membership)) throw new Error("GitHub stack membership could not be verified");
      if (membership.length) throw new Error(`Waiting for GitHub to retarget #${number} to ${stack.trunk.branch}`);
      const fresh = await get(number);
      if (fresh.state !== "open" || fresh.head?.sha !== remoteHead) throw new Error(`#${number} changed before retargeting`);
      if (fresh.base?.ref === stack.trunk.branch) return;
      if (fresh.base?.ref !== parent?.branch) throw new Error(`#${number} changed base before retargeting`);
      const updated = await request(repository, {
        path: `${path}/pulls/${number}`, method: "PATCH", body: { base: stack.trunk.branch },
      }, signal) as Pull;
      if (updated.state !== "open" || updated.base?.ref !== stack.trunk.branch || updated.head?.sha !== remoteHead) {
        throw new Error(`GitHub did not confirm the retarget of #${number}`);
      }
    },
  };
}

export async function readStackTrunk(git: StackGit, remote: string, trunk: string, fetch = false): Promise<string> {
  const ref = branchRef(trunk);
  await git.output(["check-ref-format", ref]);
  const output = await git.output(["ls-remote", "--refs", "--exit-code", "--", remote, ref]);
  const [tip, name] = output.trimEnd().split("\t");
  if (!isOid(tip) || name !== ref) throw new Error(`Could not verify remote trunk ${trunk}`);
  if (fetch) await git.output(["fetch", "--no-tags", "--no-write-fetch-head", "--", remote, tip]);
  return tip;
}

/** Deletion is deliberately left to the forge/operator. An integration that
 * cleans up a base must do so after this entire sequence succeeds. */
export async function completeStackPublication(retarget: () => Promise<void>, push: () => Promise<void>): Promise<void> {
  await retarget();
  await push();
}
