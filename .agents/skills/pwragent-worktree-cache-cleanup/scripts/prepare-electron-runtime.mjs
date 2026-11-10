import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureRuntime } from "../../../../apps/desktop/scripts/electron-runtime-cache.mjs";

const [electronDir, arch, cacheRoot = join(process.env.PWRAGENT_HOME || join(homedir(), ".pwragent"), "cache/electron-runtime/v1")] = process.argv.slice(2);
if (!electronDir || !["arm64", "x64"].includes(arch) || process.platform !== "darwin") {
  throw new Error("Expected a macOS Electron package and its measured arm64/x64 architecture");
}
const require = createRequire(join(electronDir, "package.json"));
const { version, name } = require("./package.json");
if (name !== "electron") throw new Error("Not an Electron package");
const checksums = require("./checksums.json");
const checksum = checksums[`electron-v${version}-darwin-${arch}.zip`];
if (!checksum) throw new Error("No package-pinned checksum for this version/architecture");
const { downloadArtifact } = require("@electron/get");
const identity = { format: 1, version, platform: "darwin", arch, checksum };
const key = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
const stage = mkdtempSync(join(electronDir, ".sharing-prepare-"));
try {
  await ensureRuntime({
    electronDir: stage, version, platform: "darwin", arch, cacheRoot,
    expectedChecksum: checksum, log: () => {},
    download: (options) => downloadArtifact({
      version, artifactName: "electron", checksums, platform: "darwin", arch, ...options,
    }),
  });
  const cache = join(cacheRoot, key);
  const manifest = JSON.parse(readFileSync(join(cache, "runtime.json"), "utf8"));
  if (JSON.stringify(manifest.identity) !== JSON.stringify(identity)) throw new Error("Cache identity mismatch");
  process.stdout.write(JSON.stringify({ cache, identity }));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
