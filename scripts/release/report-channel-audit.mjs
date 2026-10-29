#!/usr/bin/env node

import { closeSync, openSync, readSync, appendFileSync } from "node:fs";

// The audit emits structured public-source diagnostics, never raw gh stderr.
// Bound the read as well as the log/summary, including malformed/oversized input.
const limit = 32 * 1024;
const [file, status] = process.argv.slice(2);
let report;
let fd;
try {
  fd = openSync(file, "r");
  const buffer = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < buffer.length) {
    const count = readSync(fd, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length > limit) throw new Error("oversized");
  const parsed = JSON.parse(buffer.subarray(0, length).toString("utf8"));
  if (!["complete", "blocked", "incomplete"].includes(parsed?.status)) throw new Error("invalid");
  if (parsed.status !== "complete") process.exitCode = 1;
  report = JSON.stringify({ auditExitCode: Number(status), audit: parsed }, null, 2);
  if (Buffer.byteLength(report) > limit) throw new Error("oversized");
} catch {
  process.exitCode = 1;
  report = JSON.stringify({
    auditExitCode: Number(status), status: "incomplete",
    error: "Audit report missing, invalid or exceeds 32 KiB; inspect the retained package-manager-preflight.json",
  }, null, 2);
} finally {
  if (fd !== undefined) closeSync(fd);
}
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Package-manager channel audit\n\n\`\`\`json\n${report}\n\`\`\`\n`);
}
