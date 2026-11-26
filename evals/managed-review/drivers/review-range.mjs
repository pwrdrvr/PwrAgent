import { execFileSync } from "node:child_process";

/** A snapshot needs an unambiguous range for both review and scoring. */
export function reviewedMergeBase(repo, base, head) {
  if (![base, head].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))) {
    throw new Error("Review snapshot requires pinned base and head commits.");
  }
  const bases = execFileSync("git", ["-C", repo, "merge-base", "--all", base, head], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim().split("\n");
  if (bases.length !== 1 || !/^[0-9a-f]{40}$/.test(bases[0])) {
    throw new Error("Review snapshot requires one Git merge base.");
  }
  return bases[0];
}
