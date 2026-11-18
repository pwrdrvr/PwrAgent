#!/usr/bin/env node

// Fails when agent instruction files outgrow their budgets. Codex reads at
// most `project_doc_max_bytes` (32 KiB by default) of AGENTS.md content along
// a working directory's path, from the repository root down, and silently
// drops the rest. Claude Code loads each file on the path into a thread's
// first turn. Every chain of AGENTS.md files from the root to a nested one
// must therefore fit in 32 KiB; the root and desktop files also have their own
// limits so nested files keep room. Move detail into linked documents and
// leave a short rule plus a when-to-read trigger in AGENTS.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_AGENTS_MD_MAX_BYTES = 24 * 1024;
export const DESKTOP_AGENTS_MD_MAX_BYTES = 16 * 1024;
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

const FILE_LIMITS = [
  { path: "AGENTS.md", maxBytes: ROOT_AGENTS_MD_MAX_BYTES },
  { path: "apps/desktop/AGENTS.md", maxBytes: DESKTOP_AGENTS_MD_MAX_BYTES },
];

export function checkAgentInstructionsSize(
  bytes,
  maxBytes = ROOT_AGENTS_MD_MAX_BYTES,
  label = "AGENTS.md",
) {
  if (bytes <= maxBytes) return { ok: true, label, bytes, maxBytes };
  return {
    ok: false,
    label,
    bytes,
    maxBytes,
    message:
      `${label} is ${bytes} bytes; the limit is ${maxBytes} bytes `
      + `(${bytes - maxBytes} over). Codex truncates AGENTS.md content past `
      + "32 KiB along a working directory's path, and Claude Code loads all "
      + "of it on every first turn. Move detailed sections into linked "
      + "documents and keep a short rule plus a when-to-read trigger in "
      + "AGENTS.md.",
  };
}

// The AGENTS.md files Codex concatenates for a working directory inside
// `file`'s directory: one per ancestor directory, root first.
export function agentInstructionChain(file, files) {
  const present = new Set(files);
  const chain = [];
  let dir = posix.dirname(file);
  for (;;) {
    const candidate = dir === "." ? "AGENTS.md" : `${dir}/AGENTS.md`;
    if (present.has(candidate)) chain.unshift(candidate);
    if (dir === ".") return chain;
    dir = posix.dirname(dir);
  }
}

// `files` are repository-relative AGENTS.md paths.
export function agentInstructionLimits(files) {
  const limits = FILE_LIMITS
    .filter((limit) => files.includes(limit.path))
    .map((limit) => ({
      label: limit.path,
      paths: [limit.path],
      maxBytes: limit.maxBytes,
    }));
  for (const file of [...files].sort()) {
    const chain = agentInstructionChain(file, files);
    if (chain.length < 2) continue;
    limits.push({
      label: chain.join(" + "),
      paths: chain,
      maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    });
  }
  return limits;
}

// `readBytes(path)` returns a repository-relative file's size in bytes.
export function checkAgentInstructionLimits(readBytes, limits) {
  return limits.map((limit) => {
    const bytes = limit.paths.reduce((sum, path) => sum + readBytes(path), 0);
    return checkAgentInstructionsSize(bytes, limit.maxBytes, limit.label);
  });
}

export function listAgentInstructionFiles(repoRoot) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--", "AGENTS.md", ":(glob)**/AGENTS.md"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = listAgentInstructionFiles(repoRoot);
  const results = checkAgentInstructionLimits(
    (path) => readFileSync(join(repoRoot, path)).byteLength,
    agentInstructionLimits(files),
  );
  let failed = false;
  for (const result of results) {
    if (result.ok) {
      console.log(
        `${result.label} is ${result.bytes} of ${result.maxBytes} bytes.`,
      );
    } else {
      failed = true;
      console.error(result.message);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
