import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureRuntime } from "./electron-runtime-cache.mjs";

const require = createRequire(import.meta.url);
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronRequire = createRequire(electronPackageJsonPath);
const { downloadArtifact } = electronRequire("@electron/get");
const { version } = electronRequire("./package.json");
const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const checksums = process.env.electron_use_remote_checksums || process.env.npm_config_electron_use_remote_checksums
  ? undefined
  : electronRequire("./checksums.json");

await ensureRuntime({
  electronDir: dirname(electronPackageJsonPath),
  version, platform, arch,
  cacheRoot: join(process.env.PWRAGENT_HOME || join(homedir(), ".pwragent"), "cache/electron-runtime/v1"),
  expectedChecksum: checksums?.[`electron-v${version}-${platform}-${arch}.zip`],
  download: (options) => downloadArtifact({
    version,
    artifactName: "electron",
    force: process.env.force_no_cache === "true",
    cacheRoot: process.env.electron_config_cache,
    checksums, platform, arch,
    ...options,
  }),
});
