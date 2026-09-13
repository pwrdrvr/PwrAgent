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
 * for a full React component stack and still bounded.
 */
const MAX_LOGGED_STACK_LENGTH = 8_000;

/**
 * Nothing throttles the global `window-error` and `unhandled-rejection`
 * handlers that share this channel, and a fault inside a loop can report many
 * times a second. Re-logging a stack we just logged adds no signal and would
 * rotate the 1 MB main log within seconds, discarding the history that makes
 * the stack worth having. Log a given fault's stacks at most once per window
 * and report how many repeats were dropped.
 */
const STACK_REPEAT_WINDOW_MS = 10_000;

let lastStackFingerprint: string | undefined;
let lastStackLoggedAt = 0;
let suppressedStackCount = 0;

/**
 * The renderer's own reporter sends strings, but an IPC channel is not a type
 * system: a non-string here must not throw out of the handler and take the
 * whole report with it.
 */
function normalizeStack(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_LOGGED_STACK_LENGTH
    ? `${trimmed.slice(0, MAX_LOGGED_STACK_LENGTH)}… (${trimmed.length - MAX_LOGGED_STACK_LENGTH} more characters)`
    : trimmed;
}

function shouldLogStacks(fingerprint: string, now: number): boolean {
  if (
    fingerprint === lastStackFingerprint
    && now - lastStackLoggedAt < STACK_REPEAT_WINDOW_MS
  ) {
    suppressedStackCount += 1;
    return false;
  }
  if (suppressedStackCount > 0) {
    rendererErrorLog.error(
      `report stacks suppressed as repeats count=${suppressedStackCount}`,
    );
    suppressedStackCount = 0;
  }
  lastStackFingerprint = fingerprint;
  lastStackLoggedAt = now;
  return true;
}

export function registerRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
  ipcMain.handle(
    RENDERER_ERROR_REPORT_CHANNEL,
    async (_event, report: RendererErrorReport): Promise<{ ok: true }> => {
      const { componentStack, stack, ...summary } = report;
      rendererErrorLog.error("report", summary);
      const errorStack = normalizeStack(stack);
      const componentTrace = normalizeStack(componentStack);
      if (
        (errorStack || componentTrace)
        && shouldLogStacks(`${summary.message}\n${errorStack}\n${componentTrace}`, Date.now())
      ) {
        if (errorStack) {
          rendererErrorLog.error(`report stack\n${errorStack}`);
        }
        if (componentTrace) {
          rendererErrorLog.error(`report component stack\n${componentTrace}`);
        }
      }
      return { ok: true };
    },
  );
}

export function disposeRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
  lastStackFingerprint = undefined;
  lastStackLoggedAt = 0;
  suppressedStackCount = 0;
}

