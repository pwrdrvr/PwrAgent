#!/usr/bin/env node

// Fails when agent instruction files outgrow their budgets. Codex reads at
// most `project_doc_max_bytes` (32 KiB by default) of AGENTS.md content along
// a working directory's path and silently drops the rest. Claude Code loads
// each file on the path into a thread's first turn. The root limit leaves
// headroom under 32 KiB for nested AGENTS.md files; the desktop limit and the
// combined root + desktop limit keep a thread working in apps/desktop under
// Codex's budget. Move detail into linked documents and leave a short rule
// plus a when-to-read trigger in AGENTS.md.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_AGENTS_MD_MAX_BYTES = 24 * 1024;
export const DESKTOP_AGENTS_MD_MAX_BYTES = 16 * 1024;
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

export const AGENT_INSTRUCTION_LIMITS = [
  {
    label: "AGENTS.md",
    paths: ["AGENTS.md"],
    maxBytes: ROOT_AGENTS_MD_MAX_BYTES,
  },
  {
    label: "apps/desktop/AGENTS.md",
    paths: ["apps/desktop/AGENTS.md"],
    maxBytes: DESKTOP_AGENTS_MD_MAX_BYTES,
  },
  {
    label: "AGENTS.md + apps/desktop/AGENTS.md",
    paths: ["AGENTS.md", "apps/desktop/AGENTS.md"],
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
  },
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

// `readBytes(path)` returns a repository-relative file's size in bytes.
export function checkAgentInstructionLimits(
  readBytes,
  limits = AGENT_INSTRUCTION_LIMITS,
) {
  return limits.map((limit) => {
    const bytes = limit.paths.reduce((sum, path) => sum + readBytes(path), 0);
    return checkAgentInstructionsSize(bytes, limit.maxBytes, limit.label);
  });
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const results = checkAgentInstructionLimits(
    (path) => readFileSync(join(repoRoot, path)).byteLength,
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
