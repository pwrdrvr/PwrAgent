import type {
  RendererErrorReport,
  RendererErrorSource,
} from "../../../shared/renderer-error";
import { createRendererErrorCoalescer, rendererErrorSummary } from "../../../shared/renderer-error-coalescer";
import { getDesktopApi } from "./desktop-api";
import { installRendererUpdateConsole, retainRendererUpdateFailure, snapshotRendererUpdates } from "./renderer-update-diagnostics";

const FAULT_HASH_PRIMES = [16777619, 2246822519, 3266489917, 668265263];

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

function buildRendererErrorReport(
  source: RendererErrorSource,
  errorShape: ReturnType<typeof getErrorShape>,
  details?: {
    colno?: number;
    componentStack?: string | null;
    filename?: string;
    lineno?: number;
    updateDiagnostics?: RendererErrorReport["updateDiagnostics"];
  },
): RendererErrorReport {
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

export function createRendererErrorReport(
  source: RendererErrorSource,
  error: unknown,
  details?: Parameters<typeof buildRendererErrorReport>[2],
): RendererErrorReport {
  return buildRendererErrorReport(source, getErrorShape(error), details);
}

export function reportRendererError(report: RendererErrorReport): void {
  if (report.updateDiagnostics) retainRendererUpdateFailure(report.updateDiagnostics);
  void getDesktopApi()?.reportRendererError?.(report).catch(() => undefined);
}

export function installGlobalRendererErrorHandlers(): () => void {
  const uninstallUpdateConsole = installRendererUpdateConsole();
  const coalescer = createRendererErrorCoalescer<RendererErrorReport>((summary, repeat) => {
    reportRendererError({ ...summary, timestamp: repeat.lastTimestamp, repeat });
  });
  function reportGlobalError(source: RendererErrorSource, error: unknown, details?: {
    colno?: number; filename?: string; lineno?: number;
  }): void {
    const shape = getErrorShape(error);
    // Fixed-size, non-security fingerprint over complete identity fields. Do
    // not allocate/retain a concatenation of potentially large stacks/messages.
    const hashes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
    for (const field of [source, shape.name, shape.message, shape.stack,
      window.location.href, details?.filename, details?.lineno, details?.colno]) {
      const value = typeof field === "string" ? field : String(field);
      for (let index = -1; index <= value.length; index += 1) {
        const code = index === -1 ? 0x10001 + (typeof field === "string" ? 1 : typeof field === "number" ? 2 : 0)
          : index === value.length ? 0x10000 : value.charCodeAt(index);
        for (let lane = 0; lane < hashes.length; lane += 1) {
          hashes[lane] = Math.imul(hashes[lane] ^ code, FAULT_HASH_PRIMES[lane]);
        }
      }
    }
    const faultId = hashes.map((hash) => (hash >>> 0).toString(16).padStart(8, "0")).join("");
    let report: RendererErrorReport | undefined;
    if (coalescer.accept(faultId, () => {
      report = { ...buildRendererErrorReport(source, shape, details), faultId, reportingWindowId: crypto.randomUUID() };
      return rendererErrorSummary(report);
    }) && report) reportRendererError(report);
  }
  const handleError = (event: ErrorEvent): void => {
    reportGlobalError("window-error", event.error ?? event.message, {
      colno: event.colno,
      filename: event.filename,
      lineno: event.lineno,
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent): void => {
    reportGlobalError("unhandled-rejection", event.reason);
  };

  const handlePageHide = (): void => coalescer.dispose();
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("error", handleError);
  window.addEventListener("unhandledrejection", handleUnhandledRejection);

  return () => {
    coalescer.dispose();
    uninstallUpdateConsole();
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("error", handleError);
    window.removeEventListener("unhandledrejection", handleUnhandledRejection);
  };
}
