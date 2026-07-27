export function readAcpToolCommand(
  record: Record<string, unknown>,
): string | undefined {
  return (
    readDirectCommand(record) ??
    readDirectCommand(asRecord(record.rawInput)) ??
    readAcpToolContentCommand(record)
  );
}

export function readAcpToolInvocation(
  record: Record<string, unknown>,
): string | undefined {
  const webSearch = readAcpWebSearch(record);
  if (webSearch) {
    return webSearch.query
      ? `web_search(query=${formatInvocationValue(webSearch.query)})`
      : "web_search";
  }
  const webFetchUrl = readAcpWebFetchUrl(record);
  if (webFetchUrl) {
    return `web_fetch(url=${formatInvocationValue(webFetchUrl)})`;
  }

  const rawInput = asRecord(record.rawInput);
  if (!rawInput) {
    return undefined;
  }
  const metadata = asRecord(asRecord(record._meta)?.["x.ai/tool"]);
  const variant = readString(rawInput, "variant");
  const name =
    readString(metadata ?? {}, "name") ??
    (variant?.toLowerCase() === "grep" ? "grep" : undefined) ??
    (/^grep$/i.test(readString(record, "title") ?? "") ? "grep" : undefined);
  const kind =
    readString(metadata ?? {}, "kind") ??
    readString(record, "kind");
  if (!name || (kind !== "search" && name !== "grep" && variant !== "Grep")) {
    return undefined;
  }

  const argumentsText = Object.entries(rawInput)
    .filter(([key, value]) =>
      key !== "variant" &&
      value !== null &&
      value !== undefined &&
      value !== false,
    )
    .map(([key, value]) => {
      const displayKey = key === "-i" ? "case_insensitive" : key;
      return `${displayKey}=${formatInvocationValue(value)}`;
    })
    .join(", ");
  return argumentsText ? `${name}(${argumentsText})` : name;
}

export type AcpWebSearch = {
  query?: string;
  sources: Array<{
    title?: string;
    url?: string;
  }>;
};

export function readAcpWebSearch(
  record: Record<string, unknown>,
): AcpWebSearch | undefined {
  const rawInput = asRecord(record.rawInput);
  const rawOutput = asRecord(record.rawOutput);
  const action = asRecord(rawOutput?.action);
  const metadata = readAcpToolMetadata(record);
  const variant = readString(rawInput ?? {}, "variant");
  const toolCallId =
    readString(record, "toolCallId") ??
    readString(record, "tool_call_id");
  const outputId = readString(rawOutput ?? {}, "id");
  const isGrokWebSearchOutput =
    readString(action ?? {}, "type") === "search"
    && [toolCallId, outputId].some((id) => id?.startsWith("ws_"));
  const isWebSearch =
    variant === "WebSearch"
    || readString(metadata ?? {}, "name") === "web_search"
    || readString(metadata ?? {}, "kind") === "web_search"
    || isGrokWebSearchOutput;
  if (!isWebSearch) {
    return undefined;
  }

  const query =
    readString(action ?? {}, "query") ??
    readString(rawInput ?? {}, "query");
  const rawSources = Array.isArray(action?.sources) ? action.sources : [];
  const sources = rawSources.flatMap((value): AcpWebSearch["sources"] => {
    const source = asRecord(value);
    if (!source) {
      return [];
    }
    const sourceTitle = readString(source, "title");
    const url = readString(source, "url");
    return sourceTitle || url
      ? [
          {
            ...(sourceTitle ? { title: sourceTitle } : {}),
            ...(url ? { url } : {}),
          },
        ]
      : [];
  });
  return {
    ...(query ? { query } : {}),
    sources,
  };
}

export function readAcpWebFetchUrl(
  record: Record<string, unknown>,
): string | undefined {
  const rawInput = asRecord(record.rawInput);
  const metadata = readAcpToolMetadata(record);
  const variant = readString(rawInput ?? {}, "variant");
  const metadataName = readString(metadata ?? {}, "name");
  const metadataKind = readString(metadata ?? {}, "kind");
  const kind = readString(record, "kind");
  const title = readString(record, "title");
  const isWebFetch =
    variant?.toLowerCase() === "webfetch"
    || metadataName === "web_fetch"
    || metadataKind === "web_fetch"
    || kind === "fetch"
    || /^web_fetch$/i.test(title ?? "")
    || /^fetch:\s+/i.test(title ?? "");
  if (!isWebFetch) {
    return undefined;
  }

  return (
    readString(rawInput ?? {}, "url") ??
    readString(asRecord(metadata?.input) ?? {}, "url") ??
    /^fetch:\s+(.+)$/i.exec(title ?? "")?.[1]?.trim()
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

function readAcpToolMetadata(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return asRecord(asRecord(record._meta)?.["x.ai/tool"]);
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

function formatInvocationValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
