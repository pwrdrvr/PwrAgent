import { app, type WebContents } from "electron";

/**
 * Where a window's page load stands, for a log line about a window that has
 * not appeared. The renderer's CPU tells a spinning page from a waiting one.
 */
export function describeWebContentsLoad(contents: WebContents): Record<string, unknown> {
  if (contents.isDestroyed?.()) return { destroyed: true };
  const rendererPid = contents.getOSProcessId?.();
  const metric = app.getAppMetrics?.().find((entry) => entry.pid === rendererPid);
  return {
    url: contents.getURL?.(),
    isLoading: contents.isLoading?.(),
    isWaitingForResponse: contents.isWaitingForResponse?.(),
    isCrashed: contents.isCrashed?.(),
    rendererPid,
    rendererCpuPercent: metric?.cpu.percentCPUUsage,
  };
}
