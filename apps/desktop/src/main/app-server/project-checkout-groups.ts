import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalizeNavigationPath,
  normalizeGitOriginUrl,
  type SetProjectCheckoutGroupRequest,
} from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

const MAX_PROJECT_CHECKOUTS = 16;

function checkoutPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("Choose an absolute checkout folder.");
  }
  return canonicalizeNavigationPath(path.resolve(value));
}

function checkoutPaths(value: unknown, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_PROJECT_CHECKOUTS) {
    throw new Error(`A project can have up to ${MAX_PROJECT_CHECKOUTS} checkouts.`);
  }
  const paths = value.map(checkoutPath);
  if (new Set(paths).size !== paths.length) throw new Error("Choose each checkout once.");
  return paths;
}

async function inspectCheckout(root: string): Promise<{ path: string; common: string }> {
  try {
    const checkout = await realpath(root);
    const { stdout } = await runGitCommand(checkout, [
      "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
    ]);
    const [topLevel, gitDir, commonDir] = stdout.trimEnd().split(/\r?\n/);
    if (topLevel && gitDir && commonDir) {
      const [top, git, common] = await Promise.all([realpath(topLevel), realpath(gitDir), realpath(commonDir)]);
      if (top === checkout && git === common) return { path: canonicalizeNavigationPath(top), common };
    }
  } catch {
    // Git, rather than folder names or configured remotes, determines checkout ownership.
  }
  throw new Error(`Choose the root of a primary Git checkout: ${root}`);
}

/** Validate only the proposed group so a missing checkout can still be removed. */
export async function validateProjectCheckoutGroup(
  request: SetProjectCheckoutGroupRequest,
): Promise<SetProjectCheckoutGroupRequest> {
  const projectPath = checkoutPath(request?.projectPath);
  const previousPaths = checkoutPaths(request?.previousPaths, 0);
  const paths = checkoutPaths(request?.group?.paths, 1);
  const preferredPath = checkoutPath(request?.group?.preferredPath);
  if (!paths.includes(preferredPath)) throw new Error("Choose a preferred checkout from this project.");
  if (!previousPaths.length && paths.length > 1 && !paths.includes(projectPath)) {
    throw new Error("Include the checkout whose project you are grouping.");
  }
  if (paths.length === 1) return { projectPath, previousPaths, group: { paths, preferredPath } };

  const checkouts = await Promise.all(paths.map(inspectCheckout));
  if (new Set(checkouts.map((checkout) => checkout.common)).size !== paths.length) {
    throw new Error("Choose separate Git checkouts. Git worktrees already belong to their checkout.");
  }
  const selected = checkouts[paths.indexOf(preferredPath)]!.path;
  const origin = (await runGitCommand(selected, ["config", "--get", "remote.origin.url"])
    .catch(() => undefined))?.stdout.trim();
  const repositoryKey = origin && !/^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/]|file:)/i.test(origin)
    ? normalizeGitOriginUrl(origin) : undefined;
  return {
    projectPath: checkouts[paths.indexOf(projectPath)]?.path ?? projectPath,
    previousPaths,
    group: {
      preferredPath: selected,
      paths: checkouts.map((checkout) => checkout.path),
      ...(repositoryKey ? { repositoryKey } : {}),
    },
  };
}
