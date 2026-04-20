export type RendererErrorSource =
  | "error-boundary"
  | "window-error"
  | "unhandled-rejection";

export type RendererErrorReport = {
  colno?: number;
  componentStack?: string;
  filename?: string;
  href: string;
  lineno?: number;
  message: string;
  name?: string;
  source: RendererErrorSource;
  stack?: string;
  timestamp: string;
  userAgent: string;
};

