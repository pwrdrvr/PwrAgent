import path from "node:path";
import type {
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

    if (itemType === "commandExecution") {
      commands += 1;
      details.push({
        id: itemId,
        kind: "command",
        label: formatCommandLabel(command),
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

  const summaryParts: string[] = [];
  if (inspected > 0) {
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
