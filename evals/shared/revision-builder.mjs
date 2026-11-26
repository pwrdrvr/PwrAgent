import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve a Git revision to its 40-char commit SHA.
 */
export function resolveGitCommit(repoCwd, rev = "HEAD") {
  return execFileSync("git", ["-C", repoCwd, "rev-parse", `${rev}^{commit}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Read an optional prompt override file and compute its SHA-256 digest and word count.
 */
export function inspectPromptOverride(promptPath) {
  if (!promptPath) return null;
  const resolved = path.resolve(promptPath);
  const content = fs.readFileSync(resolved, "utf8");
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const sha256 = createHash("sha256").update(normalized).digest("hex");
  const words = normalized ? normalized.split(/\s+/).length : 0;
  return { path: resolved, sha256, shortHash: sha256.slice(0, 12), words };
}

/**
 * Ensure a headless eval driver bundle is built for a given Git revision (or the
 * current working tree when `rev` is omitted) and optional prompt override.
 *
 * When `rev` names another commit/tag/branch (for example `v1.5.1` or `main`),
 * checks out an ephemeral detached worktree outside the user's checkout, builds
 * the bundle into `<cacheRoot>/<cacheKey>/`, and cleans up the worktree.
 */
export function prepareRevisionBundle({
  repoCwd,
  buildScriptPath,
  cacheRoot,
  rev,
  promptPath,
  forceRebuild = false,
}) {
  const prompt = inspectPromptOverride(promptPath);
  const usingWorkingTree = !rev || rev === "WORKTREE";
  const commitSha = resolveGitCommit(repoCwd, usingWorkingTree ? "HEAD" : rev);
  const shortSha = commitSha.slice(0, 12);
  const revLabel = usingWorkingTree ? `worktree@${shortSha}` : `${rev}@${shortSha}`;

  const cacheKeyInput = [
    usingWorkingTree ? "worktree" : commitSha,
    prompt?.sha256 ?? "default-prompt",
  ].join(":");
  const cacheKey = usingWorkingTree
    ? `worktree-${createHash("sha256").update(cacheKeyInput).digest("hex").slice(0, 12)}`
    : `${shortSha}-${createHash("sha256").update(cacheKeyInput).digest("hex").slice(0, 12)}`;
  const distDir = path.join(cacheRoot, cacheKey);
  const markerPath = path.join(distDir, "bundle-meta.json");

  if (!usingWorkingTree && !forceRebuild && fs.existsSync(markerPath)
    && fs.existsSync(path.join(distDir, "review-matrix-driver.js"))
    && fs.existsSync(path.join(distDir, "isolated", "isolated-review-runner.js"))) {
    return {
      distDir,
      commitSha,
      revLabel,
      prompt,
      cached: true,
    };
  }

  fs.mkdirSync(distDir, { recursive: true });
  let buildRepo = repoCwd;
  let tempWorktree;
  try {
    if (!usingWorkingTree) {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-eval-rev-"));
      tempWorktree = path.join(parent, "checkout");
      execFileSync(
        "git",
        ["-C", repoCwd, "worktree", "add", "--detach", "--quiet", tempWorktree, commitSha],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      buildRepo = tempWorktree;
    }

    const buildArgs = [buildScriptPath, "--repo", buildRepo, "--out", distDir];
    if (prompt) {
      buildArgs.push("--prompt-file", prompt.path);
    }
    execFileSync(process.execPath, buildArgs, {
      cwd: repoCwd,
      stdio: "inherit",
    });

    const meta = {
      commitSha,
      rev: rev ?? "WORKTREE",
      revLabel,
      prompt,
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(markerPath, `${JSON.stringify(meta, null, 2)}\n`);
    return {
      distDir,
      commitSha,
      revLabel,
      prompt,
      cached: false,
    };
  } finally {
    if (tempWorktree) {
      try {
        execFileSync("git", ["-C", repoCwd, "worktree", "remove", "--force", tempWorktree], {
          stdio: "ignore",
        });
      } catch {
        // Fallback cleanup below if git worktree remove fails.
      }
      fs.rmSync(path.dirname(tempWorktree), { recursive: true, force: true });
    }
  }
}
