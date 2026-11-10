import type { DiagnosticDebugger } from "./debugger-lease";
export type HotCpuTarget = {
  debugger: DiagnosticDebugger;
  getOSProcessId: () => number;
  readDiagnostics?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
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
