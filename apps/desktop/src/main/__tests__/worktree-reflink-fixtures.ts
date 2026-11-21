import type { WorktreeReflinkCapabilities } from "@pwragent/shared/contracts/worktree-reflink";

// Captured on 2026-11-20 from the published darwin-universal releases with
// `git -C <repository> worktree reflink -h`. Both exit 0 and print to stdout.

export const PWRGIT_1_HELP = [
  "usage: git worktree reflink [-n] [-v | --porcelain [-z]]",
  "                        [--reflink-source=<worktree>] [<worktree>]",
  "",
  "    -n, --[no-]dry-run    report estimates without sharing data",
  "    --[no-]porcelain      machine-readable output",
  "    -z                    terminate fields with NUL",
  "    -v, --[no-]verbose    report each path and reason",
  "    --[no-]reflink-source <worktree>",
  "                          worktree holding matching physical bytes",
  "",
  "",
].join("\n");

export const PWRGIT_2_HELP = [
  "usage: git worktree reflink [-n | --verify-filters] [-v | --porcelain [-z]]",
  "                        [--reflink-source=<worktree>] [<worktree>]",
  "",
  "    -n, --[no-]dry-run    report estimates without sharing data",
  "    --[no-]verify-filters run clean filters to verify stat-ambiguous matching files",
  "    --[no-]porcelain      machine-readable output",
  "    -z                    terminate fields with NUL",
  "    -v, --[no-]verbose    report each path and reason",
  "    --[no-]reflink-source <worktree>",
  "                          worktree holding matching physical bytes",
  "",
  "",
].join("\n");

// Apple Git 2.x, which has no such subcommand: exit 129, on stderr.
export const STOCK_GIT_HELP = [
  "error: unknown subcommand: `reflink'",
  "usage: git worktree add [-f] [--detach] [--checkout] [--lock [--reason <string>]]",
  "                        [--orphan] [(-b | -B) <new-branch>] <path> [<commit-ish>]",
  "   or: git worktree list [-v | --porcelain [-z]]",
  "   or: git worktree lock [--reason <string>] <worktree>",
  "   or: git worktree move <worktree> <new-path>",
  "   or: git worktree prune [-n] [-v] [--expire <expire>]",
  "   or: git worktree remove [-f] <worktree>",
  "   or: git worktree repair [<path>...]",
  "   or: git worktree unlock <worktree>",
  "",
].join("\n");

// What 2.56.1-dev-pwrgit.1 prints when handed the option anyway (exit 129).
export const PWRGIT_1_UNKNOWN_OPTION = [
  "error: unknown option `verify-filters'",
  "usage: git worktree reflink [-n] [-v | --porcelain [-z]]",
  "                        [--reflink-source=<worktree>] [<worktree>]",
  "",
].join("\n");

export type FakeGitVersion = "pwrgit.1" | "pwrgit.2" | "stock";

export const FAKE_GIT_VERSIONS: FakeGitVersion[] = ["pwrgit.1", "pwrgit.2", "stock"];

export const FAKE_GIT_HELP: Record<FakeGitVersion, string> = {
  "pwrgit.1": PWRGIT_1_HELP,
  "pwrgit.2": PWRGIT_2_HELP,
  "stock": STOCK_GIT_HELP,
};

/** What each release really supports, written down rather than parsed. */
export const FAKE_GIT_TRUTH: Record<FakeGitVersion, WorktreeReflinkCapabilities> = {
  "pwrgit.1": { reflink: true, verifyFilters: false },
  "pwrgit.2": { reflink: true, verifyFilters: true },
  "stock": { reflink: false, verifyFilters: false },
};

/**
 * `git worktree reflink --dry-run --porcelain -z` from 2.56.1-dev-pwrgit.2 in
 * a two-file worktree, with NUL written as a newline.
 */
export const PWRGIT_2_DRY_RUN_PORCELAIN = [
  "reflink 1", "worktree /work/repo-wt", "dry-run 1", "backend clone-replace", "",
  "path a.txt", "status skipped", "reason no-donor", "error-code 0",
  "allocated-before 4096", "private-before 4096", "allocated-after 4096", "private-after 4096",
  "deduplicated-range-bytes 0", "",
  "path big.txt", "status skipped", "reason no-donor", "error-code 0",
  "allocated-before 270336", "private-before 270336", "allocated-after 270336", "private-after 270336",
  "deduplicated-range-bytes 0", "",
  "summary", "scanned 2", "eligible 0", "already-shared 0", "reshared 0", "skipped 2", "failed 0",
  "allocated-before 274432", "allocated-after 274432", "private-before 274432", "private-after 274432",
  "observed-private-reduction 0", "potential-private-reduction 0", "deduplicated-range-bytes 0",
  "allocation-unknown 0", "stat-clean 0", "content-checked 0", "content-check-bytes 0",
  "userspace-compared 0", "native-attempts 0", "native-range-bytes 0", "clone-attempts 0",
  "comparison-bytes 0", "",
].map((field) => `${field}\0`).join("");
