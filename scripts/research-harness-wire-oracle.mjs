// Offline, development-only Rust wire-shape oracle; no shipped dependency changes.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { harnessRecords } from "../apps/desktop/src/main/__tests__/fixtures/research-harness-records.ts";
import { discoveryRecords } from "../apps/desktop/src/main/__tests__/fixtures/research-discovery-records.ts";

const checkout = path.resolve(process.argv[2] ?? "");
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" });
if (revision.status !== 0 || revision.stdout.trim() !== "687f2a20dc6ff552d3c881e10910b46c13e84e2a") throw new Error("Supply the exact investigated Harness checkout");
const root = mkdtempSync(path.join(tmpdir(), "pwragent-harness-wire-"));
const manifest = `[workspace]\n[package]\nname = "pwragent-harness-wire-oracle"\nversion = "0.0.0"\nedition = "2024"\nlicense = "MIT"\n[[bin]]\nname = "oracle"\npath = "main.rs"\n[dependencies]\nserde_json = "1"\nnucleus-discovery-interface = { path = ${JSON.stringify(path.join(checkout, "interfaces/discovery"))} }\nnucleus-swarm-interface = { path = ${JSON.stringify(path.join(checkout, "interfaces/swarm"))} }\n`;
writeFileSync(path.join(root, "Cargo.toml"), manifest);
writeFileSync(path.join(root, "main.rs"), readFileSync(fileURLToPath(new URL("research-harness-wire-oracle.rs", import.meta.url))));
const result = spawnSync("cargo", ["+1.95.0", "run", "--offline", "--quiet", "--manifest-path", path.join(root, "Cargo.toml")], {
  cwd: checkout, input: JSON.stringify({ swarm: harnessRecords(), discovery: discoveryRecords() }), encoding: "utf8", maxBuffer: 1024 * 1024,
});
rmSync(root, { recursive: true, force: true });
if (result.stderr) process.stderr.write(result.stderr);
if (result.stdout) process.stdout.write(result.stdout);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
