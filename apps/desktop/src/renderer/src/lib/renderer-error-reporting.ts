import type {
  RendererErrorReport,
  RendererErrorSource,
} from "../../../shared/renderer-error";
import { getDesktopApi } from "./desktop-api";

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
  };
}

export function reportRendererError(report: RendererErrorReport): void {
  console.error("[pwragnt:renderer:error]", report);
  void getDesktopApi()
    ?.reportRendererError?.(report)
    .catch((error: unknown) => {
      console.error("[pwragnt:renderer:error] failed to report", error);
    });
}

export function installGlobalRendererErrorHandlers(): () => void {
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
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}

