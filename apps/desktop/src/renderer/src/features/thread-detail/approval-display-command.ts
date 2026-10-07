/**
 * The command an approval request asks to run, as its card and the To-dos
 * panel show it. Kept out of TranscriptList so the sidebar can read it
 * without importing the transcript.
 */
export function approvalDisplayCommand(params: Record<string, unknown>): string {
  const parsedCommand = commandFromActions(params);
  if (parsedCommand) {
    return parsedCommand;
  }

  const promptCommand =
    commandFromApprovalText(firstStringByKeys(params, ["prompt"])) ||
    commandFromApprovalText(firstStringByKeys(params, ["reason"]));
  const rawCommand = firstStringByKeys(params, [
    "command",
    "cmd",
    "displayCommand",
    "rawCommand",
    "shellCommand",
  ]);

  if (promptCommand && (!rawCommand || isGenericShellToolTitle(rawCommand))) {
    return promptCommand;
  }
  return rawCommand ? stripShellLauncher(rawCommand) : "";
}

function commandFromActions(params: Record<string, unknown>): string {
  const actions = params.commandActions;
  if (!Array.isArray(actions) || actions.length === 0) {
    return "";
  }

  return actions
    .map((action) => {
      const record = asRecord(action);
      const command = record?.command;
      return typeof command === "string" && command.trim() ? command.trim() : undefined;
    })
    .filter((command): command is string => Boolean(command))
    .join(" && ");
}

function commandFromApprovalText(text: string): string {
  const match = /^Requesting approval to Running:\s*(.+)$/imu.exec(text);
  return match?.[1]?.trim() || "";
}

function isGenericShellToolTitle(command: string): boolean {
  return /^(?:bash|shell|sh|zsh|terminal|tool)$/i.test(command.trim());
}

function firstStringByKeys(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function stripShellLauncher(command: string): string {
  const match = command.match(
    /^(?:\/[/\w]*\/)?(?:bash|zsh|sh|dash|ksh|tcsh|fish)\s+-lc\s+(['"])([\s\S]*)\1\s*$/
  );

  return match ? match[2] : command;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
