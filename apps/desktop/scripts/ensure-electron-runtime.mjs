import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const electronPackageJsonPath = require.resolve("electron/package.json");
const electronDir = dirname(electronPackageJsonPath);
const electronRequire = createRequire(electronPackageJsonPath);
const { downloadArtifact } = electronRequire("@electron/get");
const { version } = electronRequire("./package.json");

const platformPath = getPlatformPath();
const distPath = join(electronDir, "dist");
const pathFile = join(electronDir, "path.txt");
const executablePath = join(distPath, platformPath);

if (isRuntimeInstalled()) {
  process.exit(0);
}

console.log(`Electron ${version} runtime is incomplete; reinstalling runtime artifact...`);

const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  force: process.env.force_no_cache === "true",
  cacheRoot: process.env.electron_config_cache,
  checksums:
    process.env.electron_use_remote_checksums ||
    process.env.npm_config_electron_use_remote_checksums
      ? undefined
      : electronRequire("./checksums.json"),
  platform: process.env.npm_config_platform || process.platform,
  arch: process.env.npm_config_arch || process.arch,
});

rmSync(distPath, { recursive: true, force: true });
mkdirSync(distPath, { recursive: true });
extractZip(zipPath, distPath);

const distTypeDefPath = join(distPath, "electron.d.ts");
if (existsSync(distTypeDefPath)) {
  renameSync(distTypeDefPath, join(electronDir, "electron.d.ts"));
}

writeFileSync(pathFile, platformPath);

if (!existsSync(executablePath)) {
  throw new Error(`Electron runtime extraction did not create ${executablePath}`);
}

console.log(`Electron runtime installed at ${executablePath}`);

function isRuntimeInstalled() {
  if (!existsSync(executablePath) || !existsSync(pathFile)) {
    return false;
  }
  return readFileSync(pathFile, "utf8") === platformPath;
}

function extractZip(zipPath, targetDir) {
  // Electron's installer uses extract-zip, which can leave path.txt missing
  // while still exiting successfully under the Node 24 CI install path.
  const attempts =
    process.platform === "win32"
      ? [
          [
            "powershell.exe",
            [
              "-NoProfile",
              "-Command",
              `Expand-Archive -LiteralPath ${quotePowerShell(
                zipPath,
              )} -DestinationPath ${quotePowerShell(targetDir)} -Force`,
            ],
          ],
          ["tar.exe", ["-xf", zipPath, "-C", targetDir]],
        ]
      : [
          ["unzip", ["-q", "-o", zipPath, "-d", targetDir]],
          ["bsdtar", ["-xf", zipPath, "-C", targetDir]],
        ];

  const errors = [];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { stdio: "inherit" });
      return;
    } catch (error) {
      errors.push(`${command}: ${error.message}`);
    }
  }

  throw new Error(`Unable to extract Electron runtime artifact:\n${errors.join("\n")}`);
}

function getPlatformPath() {
  const platform = process.env.npm_config_platform || process.platform;

  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, "''")}'`;
}
