export type CodexProtocolCaptureStatus =
  | {
      active: false;
      available: boolean;
    }
  | {
      active: true;
      available: true;
      captureFilePath: string;
      startedAt: string;
    };

export type CodexProtocolCaptureResult = {
  captureFilePath: string;
  finalizationError?: string;
  sizeBytes?: number;
  startedAt: string;
  stoppedAt: string;
};

export function formatCodexProtocolCaptureSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildCodexProtocolCaptureHandoffMessage(
  result: CodexProtocolCaptureResult,
): string {
  const sizeLine = result.sizeBytes === undefined
    ? "Capture size: unavailable"
    : [
        `Capture size: ${formatCodexProtocolCaptureSize(result.sizeBytes)}`,
        `(${result.sizeBytes} bytes)`,
      ].join(" ");
  return [
    "PwrAgent recorded a Codex App Server protocol capture.",
    `Capture path: ${result.captureFilePath}`,
    sizeLine,
    ...(result.finalizationError
      ? [`Capture finalization warning: ${result.finalizationError}`]
      : []),
    "Privacy note: Raw protocol traffic can contain conversation content, file paths, and tool output. Review the file before sharing it.",
  ].join("\n");
}
