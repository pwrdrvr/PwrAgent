import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const [source, mountedDirectory, version, output] = process.argv.slice(2);
if (!source || !path.isAbsolute(mountedDirectory ?? "") || !version?.includes("pwragent") || !output) throw new Error("Usage: node write-runtime-manifest.mjs EXTRACTED_DIR /opt/managed VERSION OUTPUT");
const sha256 = Object.fromEntries(["codex", "codex-app-server", "codex-code-mode-host"].map((name) => [name, createHash("sha256").update(readFileSync(path.join(source, name))).digest("hex")]));
writeFileSync(output, JSON.stringify({ directory: mountedDirectory, version, sha256 }, null, 2) + "\n");
