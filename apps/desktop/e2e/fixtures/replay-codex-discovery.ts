import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CODEX_MINIMUM_RECOMMENDED_VERSION } from "@pwragent/shared";
import { CODEX_COMMAND_ENV as DISCOVERY_COMMAND_ENV } from "@pwrdrvr/codex-discovery";
import { CODEX_COMMAND_ENV } from "../../src/main/settings/desktop-settings-env";

/** Replay owns the selected CLI too; settings discovery is separate from its backend. */
export async function configureReplayCodexDiscovery(input: {
  env: Record<string, string>;
  homeRoot: string;
  configuredCommand?: string;
  explicitEnv?: Record<string, string | undefined>;
}): Promise<void> {
  if (!input.env.PWRAGENT_REPLAY_FIXTURE_PATH) return;
  const commandNames = new Set([CODEX_COMMAND_ENV, DISCOVERY_COMMAND_ENV]);
  const explicitNames = new Set(Object.keys(input.explicitEnv ?? {}).map((key) => key.toUpperCase()));

  // Windows folds environment names. Leaving a differently cased inherited
  // key can make Node pass that value instead of the fixture's selection.
  for (const key of Object.keys(input.env)) {
    const name = key.toUpperCase();
    if (commandNames.has(name) && !explicitNames.has(name)) delete input.env[key];
  }
  if ([...commandNames].some((name) => explicitNames.has(name))) return;
  if (input.configuredCommand?.trim()) return;

  const directory = path.join(input.homeRoot, "replay-codex-discovery");
  await mkdir(directory, { recursive: true });
  const command = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  const version = CODEX_MINIMUM_RECOMMENDED_VERSION;
  const body = process.platform === "win32"
    ? [
        "@echo off",
        'if "%~1"=="--version" (',
        `  echo codex-cli ${version}`,
        "  exit /b 0",
        ")",
        "echo Replay discovery fixture only supports --version 1>&2",
        "exit /b 2",
        "",
      ].join("\r\n")
    : `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then\n  printf '%s\\n' 'codex-cli ${version}'\n  exit 0\nfi\nprintf '%s\\n' 'Replay discovery fixture only supports --version' >&2\nexit 2\n`;
  try {
    await writeFile(command, body, { flag: "wx", mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Some persistence specs reopen the same owned home. Never replace a
    // different executable that a spec deliberately installed there.
    if (await readFile(command, "utf8") !== body) {
      throw new Error("Replay discovery fixture path contains different content.");
    }
  }
  input.env[CODEX_COMMAND_ENV] = command;
}
