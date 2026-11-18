import type { DiagnosticDebugger } from "./debugger-lease";
export type HotCpuTarget = {
  debugger: DiagnosticDebugger;
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
