import type { RendererUpdateSnapshot } from "./renderer-update-diagnostics";

export type RendererErrorSource =
  | "error-boundary"
  | "window-error"
  | "unhandled-rejection";

export type RendererErrorReport = {
  /** Window-local fault fingerprint linking the first report and repeat summary. */
  faultId?: string;
  /** Fixed-size ID for one admitted global-fault window, shared with its repeats. */
  reportingWindowId?: string;
  colno?: number;
  componentStack?: string;
  filename?: string;
  href: string;
  lineno?: number;
  message: string;
  name?: string;
  recovery?: {
    action: "automatic-remount" | "manual-remount" | "stopped";
    attempt: number;
    limit: number;
  };
  /** Additional occurrences since the first report; contains no new snapshot. */
  repeat?: {
    count: number;
    firstTimestamp: string;
    lastTimestamp: string;
  };
  source: RendererErrorSource;
  stack?: string;
  timestamp: string;
  userAgent: string;
  updateDiagnostics?: RendererUpdateSnapshot;
};
