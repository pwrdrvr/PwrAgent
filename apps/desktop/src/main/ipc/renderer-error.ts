import { ipcMain } from "electron";
import { createHash } from "node:crypto";
import type { RendererErrorReport } from "../../shared/renderer-error";
import { RENDERER_ERROR_REPORT_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

const rendererErrorLog = getMainLogger("pwragent:renderer:error");
const MAX_STACK_LOG_CHARACTERS = 16 * 1024;
const MAX_RECENT_STACK_LOGS = 64;
const STACK_LOG_REPEAT_INTERVAL_MS = 60_000;

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
      const { componentStack, stack, ...summary } = report;
      const javascriptStack = boundedStack(stack);
      const reactStack = boundedStack(componentStack);
      const stackId = javascriptStack || reactStack
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
        }
      }
      return { ok: true };
    },
  );
}

export function disposeRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
}
