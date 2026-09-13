import { ipcMain } from "electron";
import type { RendererErrorReport } from "../../shared/renderer-error";
import { RENDERER_ERROR_REPORT_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

const rendererErrorLog = getMainLogger("pwragent:renderer:error");

/**
 * A renderer crash is diagnosed from its stacks, and the compact field
 * formatter caps every structured value at 320 characters — enough to record
 * that a stack existed and not enough to name the frame that threw. Log each
 * stack as its own message instead: the first log argument is written
 * verbatim. The cap here is per stack rather than per field, generous enough
 * for a full React component stack and still bounded, because nothing
 * throttles the global `window-error` handler that shares this channel.
 */
const MAX_LOGGED_STACK_LENGTH = 8_000;

function boundStack(stack: string): string {
  return stack.length > MAX_LOGGED_STACK_LENGTH
    ? `${stack.slice(0, MAX_LOGGED_STACK_LENGTH)}… (${stack.length - MAX_LOGGED_STACK_LENGTH} more characters)`
    : stack;
}

export function registerRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
  ipcMain.handle(
    RENDERER_ERROR_REPORT_CHANNEL,
    async (_event, report: RendererErrorReport): Promise<{ ok: true }> => {
      const { componentStack, stack, ...summary } = report;
      rendererErrorLog.error("report", summary);
      if (stack) {
        rendererErrorLog.error(`report stack\n${boundStack(stack.trim())}`);
      }
      if (componentStack) {
        rendererErrorLog.error(
          `report component stack\n${boundStack(componentStack.trim())}`,
        );
      }
      return { ok: true };
    },
  );
}

export function disposeRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
}
