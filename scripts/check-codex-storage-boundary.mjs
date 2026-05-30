#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const scanRoots = [
  "apps/desktop/src/main",
  "scripts",
];

const excludedFiles = new Set([
  "scripts/check-codex-storage-boundary.mjs",
]);

const codeExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const storageOperationPattern =
  /\b(?:readFile(?:Sync)?|open(?:Sync)?|createReadStream|readdir(?:Sync)?|stat(?:Sync)?|lstat(?:Sync)?|existsSync|access(?:Sync)?)\s*\(|\bnew\s+Database\s*\(|\bDatabase\s*\(|\bbetter-sqlite3\b/;

const codexOwnedStoragePattern =
  /(sessionPath|session_path|rolloutPath|rollout_path|conversationPath|conversation_path|session_meta|\.codex.*(?:sessions|history|rollout|\.jsonl|\.db|sqlite|state\.db)|CODEX_HOME.*(?:sessions|history|rollout|\.jsonl|\.db|sqlite|state\.db)|codex(?:Home|_home|Root|_root|Dir|_dir|Path|_path).*?(?:sessions|history|rollout|\.jsonl|\.db|sqlite|state\.db)|codex.*(?:sqlite|state\.db|\.db|jsonl|rollout)|(?:sqlite|state\.db|\.db|jsonl|rollout).*codex)/i;

const codexContextPattern = /\bcodex\b/i;

runSelfTests();

const findings = [];

for (const scanRoot of scanRoots) {
  for (const filePath of listCodeFiles(resolve(repoRoot, scanRoot))) {
    inspectFile(filePath);
  }
}

if (findings.length > 0) {
  console.error("Codex-owned storage boundary violation detected.");
  console.error("");
  console.error("WHY THIS EXISTS:");
  console.error(
    "PwrAgent must not open, parse, query, or infer behavior from Codex-owned JSONL, rollout, or sqlite files.",
  );
  console.error(
    "Those files are private Codex implementation details. Reading them couples PwrAgent to unstable storage formats and can expose or corrupt state that only Codex owns.",
  );
  console.error("");
  console.error("WHAT TO DO INSTEAD:");
  console.error(
    "Use fields exposed by the Codex App Server protocol. If the protocol does not expose the data, update the protocol or leave the value unknown.",
  );
  console.error(
    "Do not work around this lint by renaming variables, shelling out, copying files, or scanning Codex paths indirectly.",
  );
  console.error("");
  console.error("PwrAgent-owned JSONL/sqlite/config/replay files remain OK.");
  console.error("");
  console.error("Findings:");
  for (const finding of findings) {
    console.error(`- ${finding.location}: ${finding.preview}`);
  }
  process.exit(1);
}

console.log("codex storage boundary lint passed");

function listCodeFiles(directory) {
  const results = [];
  for (const entry of readdirSync(directory)) {
    const entryPath = resolve(directory, entry);
    const relPath = relative(repoRoot, entryPath);
    if (excludedFiles.has(relPath) || relPath.includes("/__tests__/")) {
      continue;
    }

    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      results.push(...listCodeFiles(entryPath));
      continue;
    }

    if (codeExtensions.has(extensionOf(entry))) {
      results.push(entryPath);
    }
  }
  return results;
}

function inspectFile(filePath) {
  const sourceText = readFileSync(filePath, "utf8");
  const relPath = relative(repoRoot, filePath);
  const lines = sourceText.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index]);
    if (!storageOperationPattern.test(line)) {
      continue;
    }

    const context = contextFor(lines, index);
    if (
      codexOwnedStoragePattern.test(context) &&
      (codexContextPattern.test(relPath) || codexContextPattern.test(context))
    ) {
      findings.push({
        location: `${relPath}:${index + 1}`,
        preview: compact(lines[index]),
      });
    }
  }
}

function contextFor(lines, index) {
  const start = Math.max(0, index - 12);
  const end = Math.min(lines.length, index + 13);
  return lines.slice(start, end).join("\n");
}

function stripLineComment(line) {
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

function compact(value) {
  return value.trim().replace(/\s+/g, " ");
}

function extensionOf(fileName) {
  const dot = fileName.lastIndexOf(".");
  return dot === -1 ? "" : fileName.slice(dot);
}

function runSelfTests() {
  const oldFallback = `
    async function readCodexSessionOriginator(sessionPath) {
      const handle = await open(sessionPath, "r");
      return handle;
    }
  `;
  assertWouldFlag({
    relPath: "apps/desktop/src/main/codex-app-server/client.ts",
    line: 'const handle = await open(sessionPath, "r");',
    context: oldFallback,
  });

  const directCodexDb = `
    const codexHome = process.env.CODEX_HOME;
    const db = new Database(path.join(codexHome, "state.db"));
  `;
  assertWouldFlag({
    relPath: "apps/desktop/src/main/codex-app-server/db.ts",
    line: 'const db = new Database(path.join(codexHome, "state.db"));',
    context: directCodexDb,
  });

  const pwragentRollout = `
    const rolloutPath = this.rolloutPath(backendId, sessionId);
    fs.writeFileSync(rolloutPath, JSON.stringify(record));
  `;
  assertWouldNotFlag({
    relPath: "apps/desktop/src/main/acp/acp-rollout-store.ts",
    line: "fs.writeFileSync(rolloutPath, JSON.stringify(record));",
    context: pwragentRollout,
  });
}

function assertWouldFlag(sample) {
  if (!wouldFlag(sample)) {
    throw new Error(`self-test expected a Codex storage finding for ${sample.relPath}`);
  }
}

function assertWouldNotFlag(sample) {
  if (wouldFlag(sample)) {
    throw new Error(`self-test expected no Codex storage finding for ${sample.relPath}`);
  }
}

function wouldFlag({ relPath, line, context }) {
  return (
    storageOperationPattern.test(line) &&
    codexOwnedStoragePattern.test(context) &&
    (codexContextPattern.test(relPath) || codexContextPattern.test(context))
  );
}
