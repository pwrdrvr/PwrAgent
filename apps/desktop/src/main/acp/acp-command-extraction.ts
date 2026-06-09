export function readAcpToolCommand(
  record: Record<string, unknown>,
): string | undefined {
  return (
    readDirectCommand(record) ??
    readDirectCommand(asRecord(record.rawInput)) ??
    readAcpToolContentCommand(record)
  );
}

export function readAcpToolContentCommand(
  record: Record<string, unknown>,
): string | undefined {
  return isShellLikeAcpTool(record)
    ? extractCommandFromText(readAcpToolText(record.content))
    : undefined;
}

export function readAcpToolText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => readAcpToolText(item))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n").trim() : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return (
    readAcpToolText(record.text) ??
    readAcpToolText(record.content) ??
    readAcpToolText(record.output) ??
    readAcpToolText(record.result)
  );
}

export function extractCommandFromText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const trimmed = text.trim();
  const parsedCommand = extractCommandFromJsonText(trimmed);
  if (parsedCommand) {
    return parsedCommand;
  }

  const quotedMatch = /"command"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(trimmed);
  if (quotedMatch?.[1]) {
    try {
      return JSON.parse(`"${quotedMatch[1]}"`);
    } catch {
      return (
        quotedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim() ||
        undefined
      );
    }
  }

  const runningMatch = /^Requesting approval to Running:\s*(.+)$/imu.exec(trimmed);
  return runningMatch?.[1]?.trim() || undefined;
}

export function isGenericShellToolTitle(value: string | undefined): boolean {
  return /^(?:bash|shell|sh|zsh|terminal|tool)$/i.test(value?.trim() ?? "");
}

function isShellLikeAcpTool(record: Record<string, unknown>): boolean {
  return (
    isShellLikeToolKind(readString(record, "kind")) ||
    isShellLikeToolKind(readString(record, "toolKind")) ||
    isShellLikeToolKind(readString(record, "toolName")) ||
    isShellLikeToolKind(readString(record, "name")) ||
    isShellToolTitle(readString(record, "title"))
  );
}

function isShellLikeToolKind(value: string | undefined): boolean {
  return /^(?:execute|exec|command|commandexecution|command_execution|shell|bash|sh|zsh|terminal)$/i.test(
    value?.trim() ?? "",
  );
}

function isShellToolTitle(value: string | undefined): boolean {
  return /^(?:bash|shell|sh|zsh|terminal)$/i.test(value?.trim() ?? "");
}

function readDirectCommand(
  record: Record<string, unknown> | undefined,
): string | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of [
    "command",
    "cmd",
    "displayCommand",
    "shellCommand",
    "commandText",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractCommandFromJsonText(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const record = asRecord(parsed);
    return readDirectCommand(record);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
