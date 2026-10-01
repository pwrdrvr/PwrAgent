import type { AppBuildIdentity } from "../shared/app-metadata";
import { runGitCommand } from "./app-server/git-executable";

/** Read the running app's checkout, rather than the shell's working directory. */
export async function readAppBuildIdentity(
  isPackaged: boolean,
  appPath: string,
): Promise<AppBuildIdentity> {
  if (isPackaged) return { kind: "packaged" };

  const identity: AppBuildIdentity = { kind: "development", appPath };
  try {
    const { stdout } = await runGitCommand(appPath, [
      "rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD",
    ], { timeout: 2_000, maxBuffer: 64 * 1024 });
    const [checkoutPath, commitSha, branch] = stdout.trim().split("\n").map((value) => value.trim());
    if (!checkoutPath || !commitSha || !branch) return identity;
    return {
      ...identity,
      checkoutPath,
      commitSha,
      ...(branch === "HEAD" ? { detachedHead: true } : { branch }),
    };
  } catch {
    // Untracked source copies still have a useful app path and build kind.
    return identity;
  }
}
