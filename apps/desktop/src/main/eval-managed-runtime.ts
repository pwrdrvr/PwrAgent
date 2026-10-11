import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** An unpackaged eval can pin the complete managed release without updating it. */
export async function readEvalManagedRuntime(
  isPackaged: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const manifestPath = env.PWRAGENT_DEV_EVAL_RUNTIME_MANIFEST;
  if (!manifestPath) return undefined;
  if (isPackaged) throw new Error("Eval runtime manifests require an unpackaged application");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version?: string;
    directory?: string;
    sha256?: Record<string, string>;
  };
  if (!manifest.version?.includes("pwragent")
    || !manifest.directory || !path.isAbsolute(manifest.directory)) {
    throw new Error("Invalid pinned managed Codex manifest");
  }
  const names = ["codex", "codex-app-server", "codex-code-mode-host"];
  for (const name of names) {
    const command = path.join(manifest.directory, name);
    await access(command, constants.X_OK);
    const expected = manifest.sha256?.[name];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)
      || createHash("sha256").update(await readFile(command)).digest("hex") !== expected) {
      throw new Error(`Pinned managed Codex hash mismatch: ${name}`);
    }
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 10_000 });
    const banner = name === "codex" ? "codex-cli" : name;
    if (stdout.trim() !== `${banner} ${manifest.version}`) {
      throw new Error(`Pinned managed Codex version mismatch: ${name}`);
    }
  }
  return {
    command: path.join(manifest.directory, "codex"),
    appServerCommand: path.join(manifest.directory, "codex-app-server"),
    codeModeHostCommand: path.join(manifest.directory, "codex-code-mode-host"),
    metadata: {
      asset: "eval-pinned-bundle",
      repository: "pwrdrvr/codex",
      schemaVersion: 1 as const,
      tag: manifest.version,
      version: manifest.version,
      sha256: manifest.sha256!.codex,
      checkedAt: Date.now(),
      installedAt: Date.now(),
    },
  };
}
