import type {
  AppServerThreadActivityDetail,
  AppServerThreadBrowserUseDetail,
  AppServerThreadBrowserUseHandoffReason,
  AppServerThreadBrowserUseWebMcpTool,
} from "./contracts/normalized-app-server";
import { formatToolActivityTitle } from "./tool-activity";

// This package compiles without DOM or Node types. Every runtime it ships to
// (Electron main, renderer, Node tests) has the WHATWG URL global.
type ParsedUrl = {
  protocol: string;
  hostname: string;
  host: string;
  pathname: string;
  search: string;
  username: string;
  password: string;
  href: string;
};
declare const URL: new (input: string) => ParsedUrl;

const MAX_BROWSER_SCREENSHOT_DATA_URL_CHARS = 786_455;
const BROWSER_SCREENSHOT_DATA_URL_PATTERN =
  /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

const HANDOFF_REASONS = new Set<AppServerThreadBrowserUseHandoffReason>([
  "authentication",
  "captcha",
  "user_requested",
  "other",
]);

const KNOWN_BROWSER_SURFACE_LABELS: Readonly<Record<string, string>> = {
  iab: "In-app browser",
  chrome: "Chrome",
  edge: "Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  opera: "Opera",
  arc: "Arc",
  safari: "Safari",
  firefox: "Firefox",
  cdp: "Browser (CDP)",
  dot: "In-app browser",
};

const BROWSER_BATCH_AUXILIARY_TOOL_PATTERN =
  /(?:^|\/)(?:(?:cua_repl|node_repl)\/js|codex_app\/update_running_summary)$/iu;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readWrappedCallToolResultMeta(
  result: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const direct = asRecord(result?._meta);
  if (direct) return direct;
  const content = result?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const text = typeof block === "string"
      ? block
      : readString(asRecord(block), "text");
    if (!text) continue;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const wrapper = asRecord(parsed);
    if (
      !wrapper
      || (!Array.isArray(wrapper.content) && typeof wrapper.isError !== "boolean")
    ) {
      continue;
    }
    const nestedMeta = asRecord(wrapper._meta);
    if (nestedMeta) return nestedMeta;
  }
  return undefined;
}

/**
 * Identifies sibling Codex Browser/App bookkeeping MCP calls that routinely
 * appear inside a Browser Use activity batch (for example a pre-connect
 * `cua_repl/js` probe, a truncated screenshot `cua_repl/js` result, or
 * `codex_app/update_running_summary`). When a batch already carries verified
 * Browser Use metadata, these auxiliary calls should not prepend a noisy
 * `"Used N tools · "` prefix onto the browser card headline.
 */
export function isCodexBrowserBatchAuxiliaryTool(
  toolIdentifier: string | undefined,
): boolean {
  return Boolean(
    toolIdentifier
    && BROWSER_BATCH_AUXILIARY_TOOL_PATTERN.test(toolIdentifier.trim()),
  );
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readSafeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4_096) return undefined;
  let parsed: ParsedUrl;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    return undefined;
  }
  return parsed.href;
}

function readSafeBrowserScreenshotUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > MAX_BROWSER_SCREENSHOT_DATA_URL_CHARS
    || !BROWSER_SCREENSHOT_DATA_URL_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function readHandoffReason(
  value: unknown,
): AppServerThreadBrowserUseHandoffReason | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as AppServerThreadBrowserUseHandoffReason;
  return HANDOFF_REASONS.has(normalized) ? normalized : undefined;
}

function readWebMcpTools(
  value: unknown,
): AppServerThreadBrowserUseWebMcpTool[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const tools: AppServerThreadBrowserUseWebMcpTool[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    const name = readString(record, "name");
    if (!name) continue;
    const title = readString(record, "title");
    const sourceHostname = readString(record, "sourceHostname");
    const key = `${name}\u0000${sourceHostname ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push({
      name,
      ...(title ? { title } : {}),
      ...(sourceHostname ? { sourceHostname } : {}),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

function historyProviderCompatibleWithBackend(
  backend: string | undefined,
  provider: string | undefined,
): boolean {
  if (!backend || !provider) return true;
  const normalizedBackend = backend.toLowerCase();
  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === "iab") {
    return normalizedBackend === "iab";
  }
  if (normalizedProvider === "chrome" || normalizedProvider === "edge") {
    return normalizedBackend === "chrome" || normalizedBackend === "edge";
  }
  return normalizedBackend === normalizedProvider;
}

/**
 * Extract structured Codex Browser Use metadata from an `mcpToolCall` item's
 * App Server `result._meta`.
 *
 * Supported wire evidence:
 * - `result._meta["codex/toolSurface"]` with `kind === "browserUse"`
 * - `result._meta["codex/browserUse"] === true` when `codex/toolSurface` is absent
 * - `result._meta.browser_use.url` and `toolSurface.screenshot.pageUrl` (http/https only)
 * - `toolSurface.backend`, `browserFamily`, `browserId`, `history`, `screenshot`,
 *   `manualHandoffReason`, `manualHandoffTabId`, `sessionEnded`, `webMcpCalls`
 * - `result._meta.cloud_browser_handoff`
 *
 * Returns `undefined` when evidence is absent, belongs to a different toolSurface
 * kind, or contains contradictory surface/history identity fields.
 */
export function extractCodexBrowserUseDetail(
  item: Record<string, unknown>,
): AppServerThreadBrowserUseDetail | undefined {
  const result = asRecord(item.result);
  const meta = readWrappedCallToolResultMeta(result);
  if (!meta) return undefined;

  const hasToolSurfaceField = Object.prototype.hasOwnProperty.call(
    meta,
    "codex/toolSurface",
  );
  const toolSurface = asRecord(meta["codex/toolSurface"]);
  const toolSurfaceKind = readString(toolSurface, "kind");
  const isBrowserUseSurface = toolSurfaceKind === "browserUse";

  if (hasToolSurfaceField && !isBrowserUseSurface) {
    return undefined;
  }
  if (!isBrowserUseSurface && meta["codex/browserUse"] !== true) {
    return undefined;
  }

  const history = asRecord(toolSurface?.history);
  const backend = readString(toolSurface, "backend");
  const historyProvider = readString(history, "provider");
  if (!historyProviderCompatibleWithBackend(backend, historyProvider)) {
    return undefined;
  }

  const surfaceBrowserId = readString(toolSurface, "browserId");
  const historyBrowserId = readString(history, "browser_id");
  if (
    surfaceBrowserId
    && historyBrowserId
    && surfaceBrowserId !== historyBrowserId
  ) {
    return undefined;
  }

  const browserId = surfaceBrowserId ?? historyBrowserId;
  const rawBrowserFamily = readString(toolSurface, "browserFamily");
  const browserFamily =
    rawBrowserFamily
    ?? (historyProvider && historyProvider !== "iab" ? historyProvider : undefined);

  const screenshot = asRecord(toolSurface?.screenshot);
  const browserUseMeta = asRecord(meta.browser_use);
  const url =
    readSafeHttpUrl(browserUseMeta?.url)
    ?? readSafeHttpUrl(screenshot?.pageUrl);

  const historyHandoff = asRecord(history?.handoff);
  const tabId =
    readString(screenshot, "tabId")
    ?? readString(historyHandoff, "tabId")
    ?? readString(toolSurface, "manualHandoffTabId");

  const handoffReason =
    readHandoffReason(historyHandoff?.reason)
    ?? readHandoffReason(toolSurface?.manualHandoffReason);

  const cloudHandoff = asRecord(meta.cloud_browser_handoff) !== undefined;
  const sessionEnded = toolSurface?.sessionEnded === true;

  const screenshotUrl =
    history?.screenshot === false
      ? undefined
      : readSafeBrowserScreenshotUrl(screenshot?.url);

  const webMcpTools = readWebMcpTools(toolSurface?.webMcpCalls);

  return {
    ...(backend ? { backend } : {}),
    ...(browserFamily ? { browserFamily } : {}),
    ...(browserId ? { browserId } : {}),
    ...(url ? { url } : {}),
    ...(tabId ? { tabId } : {}),
    ...(handoffReason ? { handoffReason } : {}),
    ...(cloudHandoff ? { cloudHandoff: true } : {}),
    ...(sessionEnded ? { sessionEnded: true } : {}),
    ...(screenshotUrl ? { screenshotUrl } : {}),
    ...(webMcpTools ? { webMcpTools } : {}),
  };
}

export function formatBrowserSurfaceLabel(
  detail: Pick<
    AppServerThreadBrowserUseDetail,
    "backend" | "browserFamily" | "cloudHandoff"
  >,
): string {
  if (detail.cloudHandoff) {
    return "Cloud browser";
  }
  const familyKey = detail.browserFamily?.trim().toLowerCase();
  if (familyKey && KNOWN_BROWSER_SURFACE_LABELS[familyKey]) {
    return KNOWN_BROWSER_SURFACE_LABELS[familyKey];
  }
  const backendKey = detail.backend?.trim().toLowerCase();
  if (backendKey && KNOWN_BROWSER_SURFACE_LABELS[backendKey]) {
    return KNOWN_BROWSER_SURFACE_LABELS[backendKey];
  }
  if (detail.browserFamily) {
    return detail.browserFamily;
  }
  return "Browser";
}

export function formatBrowserHandoffLabel(
  reason: AppServerThreadBrowserUseHandoffReason,
): string {
  switch (reason) {
    case "authentication":
      return "Sign-in required";
    case "captcha":
      return "Verification required";
    case "user_requested":
      return "Handed off";
    default:
      return "Action required";
  }
}

export function formatBrowserUrlDisplay(url: string): string {
  let parsed: ParsedUrl;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
  const display = `${parsed.host}${path}`;
  return display.length > 64 ? `${display.slice(0, 61)}...` : display;
}

export function formatBrowserUrlHost(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Canonical surface identity key for checking whether multiple browser tool
 * calls target the same browser session. Returns `undefined` when neither
 * backend nor browserId is present.
 */
export function browserUseSurfaceKey(
  detail: Pick<AppServerThreadBrowserUseDetail, "backend" | "browserFamily" | "browserId">,
): string | undefined {
  const backend = detail.backend?.trim().toLowerCase() ?? "";
  const browserId = detail.browserId?.trim() ?? "";
  const family = detail.browserFamily?.trim().toLowerCase() ?? "";
  if (!backend && !browserId && !family) return undefined;
  return JSON.stringify([backend, browserId, family]);
}

export function formatCodexBrowserUseDetailLabel(
  detail: AppServerThreadBrowserUseDetail,
  explicitTitle?: string,
): string {
  if (explicitTitle?.trim()) {
    return formatToolActivityTitle(explicitTitle);
  }
  const surface = formatBrowserSurfaceLabel(detail);
  if (detail.url) {
    return `${surface} · ${formatBrowserUrlDisplay(detail.url)}`;
  }
  if (detail.handoffReason) {
    return `${surface} · ${formatBrowserHandoffLabel(detail.handoffReason)}`;
  }
  return surface;
}

function stripElapsedSuffix(label: string): string {
  return label.replace(/\s+\([\d.]+m?s\)$/u, "").trim();
}

export function summarizeCodexBrowserUseDetails(
  details: readonly AppServerThreadActivityDetail[],
): string | undefined {
  const browserDetails = details.filter(
    (detail): detail is AppServerThreadActivityDetail & {
      browserUse: AppServerThreadBrowserUseDetail;
    } => Boolean(detail.browserUse),
  );
  if (browserDetails.length === 0) return undefined;

  const latest = browserDetails[browserDetails.length - 1]!;
  const latestMeta = latest.browserUse;
  if (browserDetails.every((detail) => detail.status === "failed")) {
    return "Browser action failed";
  }
  if (latestMeta.handoffReason === "authentication") {
    return "Paused for sign-in";
  }
  if (latestMeta.handoffReason === "captcha") {
    return "Paused for verification";
  }

  if (browserDetails.length === 1) {
    const cleanLabel = stripElapsedSuffix(latest.label);
    const defaultLabel = formatCodexBrowserUseDetailLabel(latestMeta);
    if (cleanLabel && cleanLabel !== defaultLabel) {
      return cleanLabel;
    }
  }

  let latestUrl: string | undefined;
  for (let index = browserDetails.length - 1; index >= 0; index -= 1) {
    const candidateUrl = browserDetails[index]?.browserUse.url;
    if (candidateUrl) {
      latestUrl = candidateUrl;
      break;
    }
  }
  const host = latestUrl ? formatBrowserUrlHost(latestUrl) : undefined;
  if (host) {
    return `Browsed ${host}`;
  }
  return `Used ${formatBrowserSurfaceLabel(latestMeta).toLowerCase()}`;
}
