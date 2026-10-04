import type {
  RendererErrorReport,
  RendererErrorSource,
} from "../../../shared/renderer-error";
import { getDesktopApi } from "./desktop-api";
import { installRendererUpdateConsole, retainRendererUpdateFailure, snapshotRendererUpdates } from "./renderer-update-diagnostics";

function getErrorShape(error: unknown): {
  message: string;
  name?: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: typeof error === "string" ? error : String(error),
  };
}

export function createRendererErrorReport(
  source: RendererErrorSource,
  error: unknown,
  details?: {
    colno?: number;
    componentStack?: string | null;
    filename?: string;
    lineno?: number;
    updateDiagnostics?: RendererErrorReport["updateDiagnostics"];
  },
): RendererErrorReport {
  const errorShape = getErrorShape(error);

  return {
    ...errorShape,
    colno: details?.colno,
    componentStack: details?.componentStack ?? undefined,
    filename: details?.filename,
    href: window.location.href,
    lineno: details?.lineno,
    source,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    updateDiagnostics: details?.updateDiagnostics ?? snapshotRendererUpdates(),
  };
}

export function reportRendererError(report: RendererErrorReport): void {
  if (report.updateDiagnostics) retainRendererUpdateFailure(report.updateDiagnostics);
  void getDesktopApi()?.reportRendererError?.(report).catch(() => undefined);
}

export function installGlobalRendererErrorHandlers(): () => void {
  const uninstallUpdateConsole = installRendererUpdateConsole();
  const handleError = (event: ErrorEvent): void => {
    reportRendererError(
      createRendererErrorReport("window-error", event.error ?? event.message, {
        colno: event.colno,
        filename: event.filename,
        lineno: event.lineno,
      }),
    );
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportRendererError(
      createRendererErrorReport("unhandled-rejection", event.reason),
    );
  };

  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  return () => {
    uninstallUpdateConsole();
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}
