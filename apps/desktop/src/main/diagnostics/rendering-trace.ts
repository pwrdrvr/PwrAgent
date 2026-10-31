import { open } from "node:fs/promises";
import type { WebContents } from "electron";
import { acquireDebuggerLease, type DebuggerLease } from "./debugger-lease";

// Chromium converts these CDP keys to its native trace-config dictionary.
// No screenshots, JS stacks, user timing, URLs, DOM or trace arguments exported.
export const RENDERING_TRACE_CONFIG = {
  recordMode: "recordUntilFull",
  traceBufferSizeInKb: 8192,
  enableArgumentFilter: true,
  includedCategories: ["cc", "viz", "gpu", "devtools.timeline", "disabled-by-default-devtools.timeline.frame"],
  excludedCategories: ["*"],
};

/** The lease owns the connection; a successful Tracing.start owns the trace. */
export class RenderingTrace {
  private lease: DebuggerLease | undefined;
  private recording = false;
  private ending = false;
  private lost = false;
  private complete!: (stream: string | undefined) => void;
  private readonly completed = new Promise<string | undefined>((resolve) => { this.complete = resolve; });
  readonly bufferUsage = { percentage: 0, value: 0 };

  private readonly onLost = () => {
    this.lost = true;
    this.complete(undefined);
    this.onInterrupted();
  };
  private readonly onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method === "Tracing.bufferUsage" && this.recording) {
      if (typeof params.percentFull === "number" && Number.isFinite(params.percentFull)) {
        this.bufferUsage.percentage = Math.max(this.bufferUsage.percentage, params.percentFull);
      }
      if (typeof params.eventCount === "number" && Number.isFinite(params.eventCount)) {
        this.bufferUsage.value = Math.max(this.bufferUsage.value, params.eventCount);
      }
    }
    if (method === "Tracing.tracingComplete" && this.ending) {
      this.complete(typeof params.stream === "string" ? params.stream : undefined);
    }
  };

  constructor(private readonly target: WebContents, private readonly onInterrupted: () => void) {}

  async start(): Promise<void> {
    if (this.target.isDestroyed() || this.target.isDevToolsOpened()) throw new Error("Trace target unavailable");
    this.lease = acquireDebuggerLease(this.target.debugger, "Tracing");
    this.target.on("destroyed", this.onLost);
    this.target.debugger.on("detach", this.onLost);
    this.target.debugger.on("message", this.onMessage);
    // Chromium rejects overlap atomically, including an external contentTracing
    // session. Never stop a recording merely to discover whether it is ours.
    await this.target.debugger.sendCommand("Tracing.start", {
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      bufferUsageReportingInterval: 250,
      traceConfig: RENDERING_TRACE_CONFIG,
    });
    this.recording = true;
    if (this.lost || !this.lease.valid) throw new Error("Trace target lost");
  }

  async stop(rawPath: string): Promise<void> {
    if (!this.recording || this.ending || this.lost || !this.lease?.valid) throw new Error("Trace not owned");
    this.ending = true;
    let stream: string | undefined;
    try {
      // One end attempt only. Retrying after an error could address a new trace.
      await this.target.debugger.sendCommand("Tracing.end");
      stream = await this.completed;
      if (!stream || this.lost) throw new Error("Trace stream unavailable");
      const file = await open(rawPath, "wx", 0o600);
      try {
        let bytes = 0;
        for (;;) {
          if (this.lost || !this.lease.valid) throw new Error("Trace target lost");
          const chunk = await this.target.debugger.sendCommand("IO.read", { handle: stream, size: 65536 }) as {
            data: string; base64Encoded?: boolean; eof: boolean;
          };
          const data = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
          bytes += data.length;
          if (bytes > 64 * 1024 * 1024) throw new Error("Rendering trace exceeded 64 MiB");
          await file.write(data);
          if (chunk.eof) break;
        }
      } finally {
        await file.close();
      }
      if (this.lost || !this.lease.valid) throw new Error("Trace target lost");
    } finally {
      if (stream && !this.lost && this.lease?.valid) {
        await this.target.debugger.sendCommand("IO.close", { handle: stream });
      }
    }
  }

  release(): void {
    this.target.removeListener("destroyed", this.onLost);
    this.target.debugger.removeListener("detach", this.onLost);
    this.target.debugger.removeListener("message", this.onMessage);
    this.lease?.release(this.target.isDestroyed());
    this.lease = undefined;
  }
}
