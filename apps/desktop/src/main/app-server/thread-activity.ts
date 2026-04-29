import path from "node:path";
import type {
  AppServerThreadCommandDetail,
  AppServerSource,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadActivityStatus,
} from "@pwragnt/shared";

export function summarizeToolActivityItems(
  items: Record<string, unknown>[],
  createdAt?: number,
): AppServerThreadActivityEntry | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const details: AppServerThreadActivityDetail[] = [];
  let inspected = 0;
  let commands = 0;
  let writes = 0;
  let status: AppServerThreadActivityStatus | undefined;
  const namedToolSummaries: string[] = [];

  for (const item of items) {
    const itemId = pickString(item, ["id", "itemId", "item_id"]) ?? `activity-${details.length + 1}`;
    const itemStatus = normalizeActivityStatus(item);
    if (itemStatus === "failed") {
      status = "failed";
    } else if (!status) {
      status = itemStatus;
    }

    const itemType = pickString(item, ["type"]);
    const toolName = pickString(item, ["toolName", "tool_name", "name"]);
    const commandAction = pickString(item, ["commandAction", "command_action"]);
    const command = pickString(item, ["command"]);

    if (toolName === "search_web" || toolName === "search_x") {
      inspected += 1;
      const args = asRecord(item.arguments);
      const query = pickString(args ?? {}, ["query", "q", "search", "term"]);
      const outputText = readToolOutputText(item);
      const elapsedMs = readElapsedMs(item);
      const displayName = formatSearchToolName(toolName, itemStatus);
      namedToolSummaries.push(formatSearchToolName(toolName, "completed"));
      details.push({
        id: itemId,
        kind: "read",
        label: formatSearchToolLabel({
          displayName,
          query,
          outputText,
          elapsedMs,
          status: itemStatus,
        }),
        status: itemStatus,
      });

      for (const [index, source] of extractSources(item).slice(0, 5).entries()) {
        const label = source.title?.trim() || source.url?.trim();
        if (!label) {
          continue;
        }
        details.push({
          id: `${itemId}-source-${index + 1}`,
          kind: "read",
          label,
          url: source.url,
          status: itemStatus,
        });
      }
      continue;
    }

    if (itemType === "commandExecution") {
      commands += 1;
      const elapsedMs = readElapsedMs(item);
      details.push({
        id: itemId,
        kind: "command",
        label: appendElapsedLabel(formatCommandLabel(command), elapsedMs),
        command: buildCommandDetail(item, command, elapsedMs),
        status: itemStatus,
      });
      continue;
    }

    if (toolName === "read_file" || commandAction === "read") {
      inspected += 1;
      const filePath = extractPath(item);
      details.push({
        id: itemId,
        kind: "read",
        label: `Read ${formatPathName(filePath)}`,
        path: filePath,
        status: itemStatus,
      });
      continue;
    }

    if (toolName === "search_code" || commandAction === "search") {
      inspected += 1;
      const filePath = extractPath(item);
      details.push({
        id: itemId,
        kind: "read",
        label: filePath ? `Searched ${formatPathName(filePath)}` : "Searched code",
        path: filePath,
        status: itemStatus,
      });
      continue;
    }

    if (toolName === "list_files" || commandAction === "listFiles") {
      inspected += 1;
      const filePath = extractPath(item);
      details.push({
        id: itemId,
        kind: "read",
        label: filePath ? `Listed ${formatPathName(filePath)}` : "Listed files",
        path: filePath,
        status: itemStatus,
      });
      continue;
    }

    if (toolName === "write_file" || toolName === "edit_file") {
      writes += 1;
      const filePath = extractPath(item);
      details.push({
        id: itemId,
        kind: "write",
        label: `${toolName === "edit_file" ? "Edited" : "Wrote"} ${formatPathName(filePath)}`,
        path: filePath,
        status: itemStatus,
      });
      continue;
    }
  }

  if (details.length === 0) {
    return undefined;
  }

  const uniqueToolSummaries = [...new Set(namedToolSummaries)];
  const summaryParts: string[] = [];
  if (uniqueToolSummaries.length === 1 && inspected === 1 && commands === 0 && writes === 0) {
    summaryParts.push(uniqueToolSummaries[0] ?? "Used tool");
  } else if (uniqueToolSummaries.length > 1) {
    summaryParts.push(`Used ${uniqueToolSummaries.length} tools`);
  } else if (inspected > 0) {
    summaryParts.push(`Explored ${inspected} item${inspected === 1 ? "" : "s"}`);
  }
  if (commands > 0) {
    summaryParts.push(`Ran ${commands} command${commands === 1 ? "" : "s"}`);
  }
  if (writes > 0) {
    summaryParts.push(`Edited ${writes} file${writes === 1 ? "" : "s"}`);
  }

  return {
    type: "activity",
    id: `activity-${pickString(items[0] ?? {}, ["id", "itemId", "item_id"]) ?? "1"}`,
    summary: summaryParts.length > 0
      ? summaryParts.join(", ")
      : `Recorded ${details.length} activity item${details.length === 1 ? "" : "s"}`,
    createdAt,
    status,
    details,
  };
}

function formatSearchToolName(
  toolName: string,
  status: AppServerThreadActivityStatus | "completed" | undefined,
): string {
  if (toolName === "search_web") {
    return status === "in_progress" ? "Searching Web" : "Searched Web";
  }
  return status === "in_progress" ? "Searching X" : "Searched X";
}

function formatSearchToolLabel(params: {
  displayName: string;
  query?: string;
  outputText?: string;
  elapsedMs?: number;
  status?: AppServerThreadActivityStatus;
}): string {
  const durationSuffix = params.elapsedMs ? ` (${formatElapsedMs(params.elapsedMs)})` : "";
  const querySuffix = params.query ? `: ${params.query}` : "";
  if (params.status === "in_progress") {
    return `${params.displayName}${durationSuffix}${querySuffix}`;
  }
  const preview = summarizeToolOutput(params.outputText);
  return preview
    ? `${params.displayName}${durationSuffix}${querySuffix} - ${preview}`
    : `${params.displayName}${durationSuffix}${querySuffix}`;
}

function readToolOutputText(item: Record<string, unknown>): string | undefined {
  const toolName = pickString(item, ["toolName", "tool_name", "name"]);
  const directText = pickString(item, ["text"]);
  const data = asRecord(item.data);
  const dataOutput = pickString(data ?? {}, ["output", "text", "result"]);
  const output = dataOutput ?? directText;
  return output && output !== toolName ? output : undefined;
}

function summarizeToolOutput(text: string | undefined): string | undefined {
  const normalized = text
    ?.replace(/[#*_`>[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function readElapsedMs(item: Record<string, unknown>): number | undefined {
  const data = asRecord(item.data);
  const elapsedMs =
    pickNumber(item, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]) ??
    pickNumber(data ?? {}, ["durationMs", "duration_ms", "elapsedMs", "elapsed_ms"]);
  return typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
    ? elapsedMs
    : undefined;
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }
  const seconds = elapsedMs / 1_000;
  return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
}

function appendElapsedLabel(label: string, elapsedMs: number | undefined): string {
  return typeof elapsedMs === "number" ? `${label} (${formatElapsedMs(elapsedMs)})` : label;
}

function buildCommandDetail(
  item: Record<string, unknown>,
  command: string | undefined,
  elapsedMs: number | undefined,
): AppServerThreadCommandDetail | undefined {
  const displayCommand = formatCommandLabel(command);
  if (!command && displayCommand === "Ran command") {
    return undefined;
  }

  const data = asRecord(item.data);
  const output =
    pickString(item, ["aggregatedOutput", "aggregated_output", "output"]) ??
    pickString(data ?? {}, ["aggregatedOutput", "aggregated_output", "output"]);
  const exitCode =
    pickNumber(item, ["exitCode", "exit_code"]) ??
    pickNumber(data ?? {}, ["exitCode", "exit_code"]);
  const cwd = pickString(item, ["cwd", "workingDirectory", "working_directory"]);

  return {
    displayCommand,
    ...(command ? { rawCommand: command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(output ? { output } : {}),
    ...(typeof exitCode === "number" ? { exitCode } : {}),
    ...(typeof elapsedMs === "number" ? { durationMs: elapsedMs } : {}),
  };
}

function extractSources(item: Record<string, unknown>): AppServerSource[] {
  const directSources = Array.isArray(item.sources) ? item.sources : undefined;
  const data = asRecord(item.data);
  const dataSources = Array.isArray(data?.sources) ? data.sources : undefined;
  return (directSources ?? dataSources ?? []).flatMap((source): AppServerSource[] => {
    const record = asRecord(source);
    if (!record) {
      return [];
    }
    const url = pickString(record, ["url"]);
    const title = pickString(record, ["title"]);
    if (!url && !title) {
      return [];
    }
    return [
      {
        id: pickString(record, ["id"]),
        sourceType: pickString(record, ["sourceType", "source_type", "type"]),
        url,
        title,
      },
    ];
  });
}

function normalizeActivityStatus(
  item: Record<string, unknown>,
): AppServerThreadActivityStatus | undefined {
  const status = pickString(item, ["status"]);
  if (status === "failed" || item.success === false) {
    return "failed";
  }
  if (status === "completed" || item.success === true) {
    return "completed";
  }
  if (status === "in_progress") {
    return "in_progress";
  }
  return undefined;
}

function extractPath(item: Record<string, unknown>): string | undefined {
  const directPath = pickString(item, ["path"]);
  if (directPath) {
    return directPath;
  }
  const args = asRecord(item.arguments);
  return pickString(args ?? {}, ["path"]);
}

function formatPathName(filePath: string | undefined): string {
  if (!filePath) {
    return "file";
  }
  return path.basename(filePath) || filePath;
}

function formatCommandLabel(command: string | undefined): string {
  const collapsed = command?.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "Ran command";
  }
  return collapsed.length > 72 ? `${collapsed.slice(0, 69)}...` : collapsed;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
