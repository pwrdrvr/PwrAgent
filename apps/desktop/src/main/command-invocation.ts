import path from "node:path";

const WINDOWS_BATCH_EXTENSION = /\.(?:bat|cmd)$/i;
const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

export type CommandInvocation = {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean | undefined;
};

function readWindowsEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? env[key] : undefined;
}

function escapeWindowsCmdCommand(command: string): string {
  return command.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function escapeWindowsCmdArgument(argument: string): string {
  const escapedQuotes = argument.replace(/(?=(\\+?)?)\1"/g, "$1$1\\\"");
  const escapedTrailingSlashes = escapedQuotes.replace(
    /(?=(\\+?)?)\1$/g,
    "$1$1",
  );
  return `"${escapedTrailingSlashes}"`.replace(
    WINDOWS_CMD_META_CHARACTERS,
    "^$1",
  );
}

/**
 * Preserve direct argv launches for native executables while routing Windows
 * batch shims through an explicitly escaped cmd.exe command line.
 */
export function createCommandInvocation(params: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | undefined;
}): CommandInvocation {
  const platform = params.platform ?? process.platform;
  if (
    platform !== "win32"
    || !WINDOWS_BATCH_EXTENSION.test(path.win32.extname(params.command))
  ) {
    return { command: params.command, args: params.args };
  }

  const shellCommand = [
    escapeWindowsCmdCommand(path.win32.normalize(params.command)),
    ...params.args.map(escapeWindowsCmdArgument),
  ].join(" ");

  return {
    command:
      readWindowsEnv(params.env, "ComSpec")?.trim()
      || readWindowsEnv(process.env, "ComSpec")?.trim()
      || "cmd.exe",
    args: ["/d", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
  };
}
