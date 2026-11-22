import type { DiagnosticDebugger } from "./debugger-lease";
export type HotCpuTarget = {
  debugger: DiagnosticDebugger;
  cpuProfileSamplingIntervalUs?: number;
  /** Monotonic CPU time on the thread that dispatches local inspector commands synchronously. */
  readProfilerThreadCpuMicros?: () => number;
  getOSProcessId: () => number;
  readDiagnostics?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  setListingDiagnosticsEnabled?: (enabled: boolean) => void | Promise<void>;
  isDestroyed?: () => boolean;
  isDevToolsOpened?: () => boolean;
  takeHeapSnapshot?: (filePath: string) => Promise<void>;
  readHeapUsage?: () => {
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
  };
};
