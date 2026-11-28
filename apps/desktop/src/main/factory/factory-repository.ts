import { readCurrentGitHubOrigin } from "../pr-status/git-remote";

/** Confirm the selected origin again before dispatch or admission on the executor. */
export async function matchesFactoryOrigin(directory: string, repository: string): Promise<boolean> {
  const origin = await readCurrentGitHubOrigin(directory);
  return origin?.host === "github.com" && `${origin.owner}/${origin.repo}`.toLowerCase() === repository;
}
