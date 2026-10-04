import { ipcMain } from "electron";
import { createHash } from "node:crypto";
import type { RendererErrorReport } from "../../shared/renderer-error";
import { RENDERER_UPDATE_CAPACITY, RENDERER_UPDATE_EVENT_NAMES } from "../../shared/renderer-update-diagnostics";
import { RENDERER_ERROR_REPORT_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

const rendererErrorLog = getMainLogger("pwragent:renderer:error");
const MAX_STACK_LOG_CHARACTERS = 16 * 1024;
const MAX_RECENT_STACK_LOGS = 64;
const STACK_LOG_REPEAT_INTERVAL_MS = 60_000;
const MAX_UPDATE_LOG_BYTES = 8 * 1024;

function boundedUpdateDiagnostics(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Array.isArray(input.events) || !Array.isArray(input.counts)) return undefined;
  const number = (value: unknown): number => typeof value === "number"
    && Number.isFinite(value) && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
  const events = [];
  // Bound traversal before serialization; the IPC channel is not a type system.
  for (let index = Math.max(0, input.events.length - RENDERER_UPDATE_CAPACITY); index < input.events.length; index += 1) {
    const event = input.events[index];
    if (!event || typeof event !== "object") continue;
    if (!Number.isInteger(event.event) || event.event < 0 || event.event >= RENDERER_UPDATE_EVENT_NAMES.length) continue;
    events.push({
      event: event.event,
      scope: typeof event.scope === "string" && /^[A-Za-z0-9:_-]{0,32}$/.test(event.scope) ? event.scope : "",
      firstMs: number(event.firstMs), lastMs: number(event.lastMs), count: number(event.count),
    });
  }
  const snapshot = {
    version: 1, capacity: RENDERER_UPDATE_CAPACITY,
    capturedAtMs: number(input.capturedAtMs), total: number(input.total),
    eventNames: RENDERER_UPDATE_EVENT_NAMES,
    counts: RENDERER_UPDATE_EVENT_NAMES.map((_, index) => number((input.counts as unknown[])[index])),
    omittedEvents: Math.max(0, input.events.length - events.length),
    events,
  };
  let serialized = JSON.stringify(snapshot);
  // All strings are fixed names or ASCII scopes, so bytes equal characters.
  while (serialized.length > MAX_UPDATE_LOG_BYTES && events.length > 0) {
    events.shift();
    snapshot.omittedEvents += 1;
    serialized = JSON.stringify(snapshot);
  }
  return serialized;
}

function boundedStack(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const stack = value.trim();
  if (!stack) return undefined;
  if (stack.length <= MAX_STACK_LOG_CHARACTERS) return stack;
  const suffix = "\n[stack truncated]";
  const prefix = stack.slice(0, MAX_STACK_LOG_CHARACTERS - suffix.length);
  const lastNewline = prefix.lastIndexOf("\n");
  return `${lastNewline > 0 ? prefix.slice(0, lastNewline) : prefix}${suffix}`;
}

export function registerRendererErrorIpcHandlers(): void {
  const recentStackLogs = new Map<string, number>();
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
  ipcMain.handle(
    RENDERER_ERROR_REPORT_CHANNEL,
    async (event, report: RendererErrorReport): Promise<{ ok: true }> => {
      const { componentStack, stack, updateDiagnostics, ...summary } = report;
      const javascriptStack = boundedStack(stack);
      const reactStack = boundedStack(componentStack);
      const updateLog = boundedUpdateDiagnostics(updateDiagnostics);
      const stackId = javascriptStack || reactStack || updateLog
        ? createHash("sha256").update(JSON.stringify([
            event.sender.id, report.href, report.source, report.name, report.message,
            javascriptStack, reactStack,
          ])).digest("hex").slice(0, 16)
        : undefined;
      rendererErrorLog.error("report", { ...summary, webContentsId: event.sender.id, stackId });
      if (stackId) {
        const now = Date.now();
        const previous = recentStackLogs.get(stackId);
        if (previous === undefined
          || now < previous
          || now - previous >= STACK_LOG_REPEAT_INTERVAL_MS) {
          recentStackLogs.delete(stackId);
          recentStackLogs.set(stackId, now);
          if (recentStackLogs.size > MAX_RECENT_STACK_LOGS) {
            const oldest = recentStackLogs.keys().next().value;
            if (oldest !== undefined) recentStackLogs.delete(oldest);
          }
          // Strings passed separately retain multiline frames through the
          // compact logger, whose structured string fields truncate at 320 chars.
          const context = { webContentsId: event.sender.id, stackId };
          if (javascriptStack) rendererErrorLog.error("report stack", context, javascriptStack);
          if (reactStack) rendererErrorLog.error("report component stack", context, reactStack);
          if (updateLog) rendererErrorLog.error("report update diagnostics", context, updateLog);
        }
      }
      return { ok: true };
    },
  );
}

export function disposeRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
}
