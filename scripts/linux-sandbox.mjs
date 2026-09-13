import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));

export function sandboxIsConfigured(stat) {
  return stat.isFile() && stat.uid === 0 && (stat.mode & 0o7777) === 0o4755;
}

export function runCli(args = process.argv.slice(2), {
  platform = process.platform,
  resolveHelper = () => realpathSync(join(dirname(desktopRequire.resolve("electron/package.json")), "dist/chrome-sandbox")),
  stat = statSync,
  exec = execFileSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  const fix = args.length === 1 && args[0] === "--fix";
  if (!fix && !(args.length === 1 && args[0] === "--warn")) {
    throw new Error("Usage: node scripts/linux-sandbox.mjs --warn|--fix");
  }
  if (platform !== "linux") {
    if (fix) log("Linux sandbox repair is only needed on Linux; nothing changed.");
    return;
  }

  let helper;
  let info;
  try {
    helper = resolveHelper();
    info = stat(helper);
    if (!info.isFile()) throw new Error("Sandbox helper is not a regular file");
  } catch (error) {
    if (fix) throw error;
    warn(`[linux-sandbox] Could not inspect Electron's sandbox helper: ${error.message}. If Electron is needed, run pnpm install and pnpm check:linux-sandbox.`);
    return;
  }
  if (sandboxIsConfigured(info)) {
    if (fix) log(`Linux sandbox helper is already configured: ${helper}`);
    return;
  }
  if (!fix) {
    warn([
      "[linux-sandbox] Electron may fail to launch when unprivileged user namespaces are restricted (including some Ubuntu installations).",
      `Helper: ${helper}`,
      "The setuid helper needs root ownership and mode 4755. Run pnpm fix:linux-sandbox if Electron reports the SUID sandbox error.",
      "This check does not probe user namespaces or mount policy. Install and launch never request sudo automatically.",
    ].join("\n"));
    return;
  }

  log(`Configuring Electron's Linux sandbox helper: ${helper}`);
  log("sudo will change this file to root:root and mode 4755. Run pnpm dev as your normal user afterwards.");
  // chown can clear setuid, so ownership must be changed before permissions.
  exec("sudo", ["chown", "root:root", "--", helper], { stdio: "inherit" });
  exec("sudo", ["chmod", "4755", "--", helper], { stdio: "inherit" });
  if (!sandboxIsConfigured(stat(helper))) throw new Error("Sandbox helper permissions did not verify after repair");
  log("Sandbox helper permissions verified. Re-run after an Electron replacement if needed; nosuid mounts or other host restrictions can still prevent sandbox startup.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli();
  } catch (error) {
    console.error(`[linux-sandbox] ${error.message}`);
    process.exitCode = 1;
  }
}
