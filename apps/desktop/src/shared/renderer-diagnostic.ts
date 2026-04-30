export type RendererDiagnosticLogLevel = "info" | "warn";

export type RendererDiagnosticLogRequest = {
  details?: unknown;
  level: RendererDiagnosticLogLevel;
  message: string;
};
