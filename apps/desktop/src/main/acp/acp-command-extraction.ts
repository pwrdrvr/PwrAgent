import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared/contracts/agent-tools";
import {
  ANTIGRAVITY_CALL_PWRAGENT_TOOL,
  readPwrAgentCallTarget,
} from "../agent-tools/antigravity-mcp-catalog.js";

const ANTIGRAVITY_PWRAGENT_PREFIX = `mcp_${PWRAGENT_TOOL_NAMESPACE}_`;
const ANTIGRAVITY_CALL_MCP_TOOL = `${ANTIGRAVITY_PWRAGENT_PREFIX}call_mcp_tool`;

export function readAcpToolCommand(
  record: Record<string, unknown>,
): string | undefined {
  return (
    readDirectCommand(record) ??
    readDirectCommand(asRecord(record.rawInput)) ??
    readAcpToolContentCommand(record)
  );
}

export function readAcpToolDescription(
  record: Record<string, unknown>,
): string | undefined {
  const rawInput = asRecord(record.rawInput);
  const rawOutput = asRecord(record.rawOutput);
  const metadataInput = asRecord(readAcpToolMetadata(record)?.input);
  return (
    readString(rawInput ?? {}, "description") ??
    // Antigravity's sentence about a `run_command`.
    readString(rawInput ?? {}, "toolSummary") ??
    readString(rawOutput ?? {}, "description") ??
    readString(metadataInput ?? {}, "description") ??
    readString(record, "description")
  );
}

export function readAcpToolInvocation(
  record: Record<string, unknown>,
  followsTitleScript = false,
): string | undefined {
  const mcp = readAcpMcpInvocation(record);
  if (mcp) {
    return mcp.input === undefined
      ? mcp.toolName
      : `${mcp.toolName}\n${JSON.stringify(mcp.input, null, 2)}`;
  }
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

  const codeSearch = readAcpCodeSearch(record);
  if (codeSearch) {
    return codeSearch.invocation;
  }
  // Some ACP executors supply the script only as the title.
  const title = record.title;
  return typeof title === "string"
    && /[\r\n]/.test(title.trim())
    && (isShellLikeAcpTool(record) || (followsTitleScript && !readString(record, "kind")))
    ? title
    : undefined;
}

type AcpMcpInvocation = {
  toolName: string;
  input?: unknown;
  summary?: string;
};

function readAcpMcpInvocation(
  record: Record<string, unknown>,
): AcpMcpInvocation | undefined {
  const rawInput = asRecord(record.rawInput);
  if (
    readString(rawInput ?? {}, "variant") === "UseTool"
    || readString(readAcpToolMetadata(record) ?? {}, "name") === "use_tool"
  ) {
    const toolName = readString(rawInput ?? {}, "tool_name")?.trim();
    return toolName
      ? { toolName, input: rawInput?.tool_input }
      : undefined;
  }

  const outerName =
    readString(record, "name")
    ?? stripRunPrefix(readString(record, "title"));
  if (!outerName || !/^mcp_[A-Za-z0-9_-]+$/u.test(outerName)) {
    return undefined;
  }

  const summary = readString(rawInput ?? {}, "toolSummary");
  if (outerName === ANTIGRAVITY_CALL_PWRAGENT_TOOL) {
    const target = readPwrAgentCallTarget(rawInput);
    const fallbackName = readString(rawInput ?? {}, "toolName");
    const toolName = target?.name
      ?? (fallbackName && /^[a-z][a-z0-9_]*$/u.test(fallbackName) ? fallbackName : undefined);
    if (!toolName) {
      return undefined;
    }
    const input = target?.args ?? rawInput?.arguments;
    return { toolName, ...(input !== undefined ? { input } : {}), ...(summary ? { summary } : {}) };
  }

  if (outerName === ANTIGRAVITY_CALL_MCP_TOOL) {
    const toolName = readString(rawInput ?? {}, "toolName");
    if (!toolName) {
      return undefined;
    }
    const connectionId = readString(rawInput ?? {}, "connectionId");
    const args = rawInput?.arguments;
    const input = args !== undefined
      ? (connectionId ? { connectionId, arguments: args } : args)
      : omitToolSummary(rawInput);
    return { toolName, ...(input !== undefined ? { input } : {}), ...(summary ? { summary } : {}) };
  }

  if (outerName.startsWith(ANTIGRAVITY_PWRAGENT_PREFIX)) {
    const toolName = outerName.slice(ANTIGRAVITY_PWRAGENT_PREFIX.length);
    if (!toolName) {
      return undefined;
    }
    const input = omitToolSummary(rawInput);
    return { toolName, ...(input !== undefined ? { input } : {}), ...(summary ? { summary } : {}) };
  }

  if (!rawInput) {
    return undefined;
  }
  const input = omitToolSummary(rawInput);
  return { toolName: outerName, ...(input !== undefined ? { input } : {}), ...(summary ? { summary } : {}) };
}

function stripRunPrefix(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^Run\s+(mcp_[A-Za-z0-9_-]+)$/u.exec(value.trim());
  return match?.[1];
}

function omitToolSummary(
  rawInput: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!rawInput) {
    return undefined;
  }
  const entries = Object.entries(rawInput).filter(([key]) => key !== "toolSummary");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Unwraps MCP dispatcher calls (Grok's `UseTool` and Antigravity's
 * `mcp_pwragent_call_pwragent_tool` / `mcp_pwragent_call_mcp_tool` / direct
 * `mcp_pwragent_*` calls) to the invoked sub-tool name.
 */
export function readAcpMcpToolName(
  record: Record<string, unknown>,
): string | undefined {
  return readAcpMcpInvocation(record)?.toolName;
}

export function readAcpMcpToolLabel(
  record: Record<string, unknown>,
): string | undefined {
  const mcp = readAcpMcpInvocation(record);
  if (!mcp) {
    return undefined;
  }
  if (!mcp.summary) {
    return mcp.toolName;
  }
  return mcp.summary.toLowerCase().includes(mcp.toolName.toLowerCase())
    ? mcp.summary
    : `${mcp.toolName}: ${mcp.summary}`;
}

export type AcpCodeSearch = {
  invocation: string;
  query?: string;
};

export function readAcpCodeSearch(
  record: Record<string, unknown>,
): AcpCodeSearch | undefined {
  if (readAcpWebSearch(record)) {
    return undefined;
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
  if (
    !name
    || (
      kind !== "search"
      && name.toLowerCase() !== "grep"
      && variant?.toLowerCase() !== "grep"
    )
  ) {
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
  const query =
    readString(rawInput, "pattern") ??
    readString(rawInput, "query");
  return {
    invocation: argumentsText ? `${name}(${argumentsText})` : name,
    ...(query ? { query } : {}),
  };
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
  const actionType = readString(action ?? {}, "type");
  const isGrokWebSearchOutput =
    (actionType === "search" || actionType === "find_in_page")
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
    readString(action ?? {}, "pattern") ??
    readString(rawInput ?? {}, "query");
  const actionUrl = readString(action ?? {}, "url");
  const rawSources = [
    ...(Array.isArray(action?.sources) ? action.sources : []),
    ...(actionType === "find_in_page" && actionUrl
      ? [{ url: actionUrl }]
      : []),
  ];
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
  const rawOutput = asRecord(record.rawOutput);
  const action = asRecord(rawOutput?.action);
  const metadata = readAcpToolMetadata(record);
  const variant = readString(rawInput ?? {}, "variant");
  const metadataName = readString(metadata ?? {}, "name");
  const metadataKind = readString(metadata ?? {}, "kind");
  const kind = readString(record, "kind");
  const title = readString(record, "title");
  const toolCallId =
    readString(record, "toolCallId") ??
    readString(record, "tool_call_id");
  const outputId = readString(rawOutput ?? {}, "id");
  const isGrokOpenPage =
    readString(action ?? {}, "type") === "open_page"
    && [toolCallId, outputId].some((id) => id?.startsWith("ws_"));
  const isWebFetch =
    variant?.toLowerCase() === "webfetch"
    || metadataName === "web_fetch"
    || metadataKind === "web_fetch"
    || kind === "fetch"
    || /^web_fetch$/i.test(title ?? "")
    || /^fetch:\s+/i.test(title ?? "")
    || isGrokOpenPage;
  if (!isWebFetch) {
    return undefined;
  }

  return (
    readString(rawInput ?? {}, "url") ??
    readString(action ?? {}, "url") ??
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
    // Antigravity's `run_command`.
    "CommandLine",
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

/** The first file an ACP tool call lists in `locations`. */
export function readFirstLocationPath(
  record: Record<string, unknown>,
): string | undefined {
  const locations = record.locations;
  if (!Array.isArray(locations)) {
    return undefined;
  }
  for (const location of locations) {
    const path = asRecord(location)?.path;
    if (typeof path === "string" && path.trim()) {
      return path;
    }
  }
  return undefined;
}

export type AcpProviderTool = {
  /** The agent's internal tool name, such as `search_replace`. */
  name?: string;
  /** The agent's display name for the tool, such as `Edit`. */
  label?: string;
  kind?: string;
};

/**
 * The tool identity an agent declares beside a tool call. Grok sends it as
 * `_meta["x.ai/tool"]` on the opening `tool_call` and on most updates.
 */
export function readAcpProviderTool(
  record: Record<string, unknown>,
): AcpProviderTool | undefined {
  const metadata = readAcpToolMetadata(record);
  if (!metadata) {
    return undefined;
  }
  const tool: AcpProviderTool = {
    name: readString(metadata, "name"),
    label: readString(metadata, "label"),
    kind: readString(metadata, "kind"),
  };
  return tool.name || tool.label || tool.kind ? tool : undefined;
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
