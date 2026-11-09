import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { ThreadWorktreeRegistration } from "@pwragent/shared";
import { runGitCommand } from "./git-executable";

type CheckoutIdentity = Omit<ThreadWorktreeRegistration, "authorizedAt" | "requestedBy">;

async function directoryIdentity(directory: string): Promise<string> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) throw new Error("The checkout and its Git directory must be real directories.");
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

/** Git is the authority: require a linked root, a registered checkout and its
 * matching administrative backlink. An alias must not extend authorization. */
export async function inspectRegisterableWorktree(worktreePath: string): Promise<CheckoutIdentity> {
  if (!path.isAbsolute(worktreePath)) throw new Error("worktreePath must be absolute.");
  const checkout = await realpath(worktreePath);
  if (checkout !== path.resolve(worktreePath)) throw new Error(`Use the canonical checkout path: ${checkout}`);
  const checkoutIdentity = await directoryIdentity(checkout);
  const git = async (args: string[]) => (await runGitCommand(checkout, args, { timeout: 10_000 })).stdout.trim();
  const top = await realpath(await git(["rev-parse", "--show-toplevel"]));
  if (top !== checkout) throw new Error("worktreePath must be the linked checkout root.");
  const gitDirectory = await realpath(await git(["rev-parse", "--absolute-git-dir"]));
  const commonDirectory = await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  if (gitDirectory === commonDirectory) throw new Error("Main checkouts cannot be registered for worktree cleanup.");
  const gitDirectoryIdentity = await directoryIdentity(gitDirectory);
  const backlink = (await readFile(path.join(gitDirectory, "gitdir"), "utf8")).trim();
  if (await realpath(path.resolve(gitDirectory, backlink)) !== await realpath(path.join(checkout, ".git"))) {
    throw new Error("Git's linked checkout backlink does not match.");
  }
  const listed = await git(["worktree", "list", "--porcelain", "-z"]);
  if (!listed.split("\0").includes(`worktree ${checkout.replace(/\\/g, "/")}`)) {
    throw new Error("Git does not list this linked checkout.");
  }
  if (await directoryIdentity(checkout) !== checkoutIdentity
    || await directoryIdentity(gitDirectory) !== gitDirectoryIdentity) {
    throw new Error("The checkout changed while it was being inspected.");
  }
  return { worktreePath: checkout, gitDirectory, commonDirectory, checkoutIdentity, gitDirectoryIdentity };
}

export function sameRegisteredWorktree(a: CheckoutIdentity, b: CheckoutIdentity): boolean {
  return a.worktreePath === b.worktreePath && a.gitDirectory === b.gitDirectory
    && a.commonDirectory === b.commonDirectory && a.checkoutIdentity === b.checkoutIdentity
    && a.gitDirectoryIdentity === b.gitDirectoryIdentity;
}

/** Read-only at scan, apply and final snapshot admission. No authorization
 * survives a moved/replaced checkout, broken Git link, or symlink escape. */
export async function hasWorktreeRegistration(
  worktreePath: string,
  registrations: readonly ThreadWorktreeRegistration[] = [],
): Promise<boolean> {
  const registration = registrations.find((entry) => entry.worktreePath === path.resolve(worktreePath));
  if (!registration) return false;
  try { return sameRegisteredWorktree(registration, await inspectRegisterableWorktree(worktreePath)); }
  catch { return false; }
}
