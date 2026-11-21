import { WebContentsView } from "electron";
import type {
  ChromiumTraceChunk, ChromiumTraceConfig, ChromiumTraceSession,
} from "../../diagnostics/chromium-trace";

const READ_BYTES = 512 * 1024;
// The byte cap is enforced by the publisher. Cap reads as well so an
// invalid stream cannot keep returning empty or tiny chunks.
const MAX_READS = 200;

type TargetInfo = { type?: string; targetId?: string };

// Owning the target also owns its native DevTools stream. Detaching cancels
// an unacknowledged start or a late export without touching another recorder.
export function createChromiumTraceSession(): ChromiumTraceSession {
  const { webContents } = new WebContentsView({ webPreferences: { sandbox: true } });
  const debuggerApi = webContents.debugger;
  const targets = new Map<string, Promise<void>>();
  let closed = false;
  let started = false;
  let trackingTargets = false;
  let ownTargetId: string | undefined;
  let complete!: (handle?: string) => void;
  const completion = new Promise<string | undefined>((resolve) => { complete = resolve; });

  function attach(target: TargetInfo | undefined): Promise<void> | undefined {
    const id = target?.targetId;
    if (closed || target?.type !== "page" || !id || id === ownTargetId) return;
    let pending = targets.get(id);
    if (!pending) {
      pending = debuggerApi.sendCommand("Target.attachToTarget", { targetId: id, flatten: true });
      targets.set(id, pending);
    }
    return pending;
  }

  function message(_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (closed || sessionId) return;
    if (method === "Target.targetCreated" && trackingTargets) {
      void attach(params.targetInfo as TargetInfo | undefined)?.catch(() => {});
    }
    if (method === "Target.targetDestroyed" && typeof params.targetId === "string") {
      targets.delete(params.targetId);
    }
    if (method === "Tracing.tracingComplete") {
      complete(typeof params.stream === "string" ? params.stream : undefined);
    }
  }

  const detached = () => complete();

  return {
    async start(config: ChromiumTraceConfig) {
      debuggerApi.attach("1.3");
      debuggerApi.on("message", message);
      debuggerApi.on("detach", detached);
      // Chromium snapshots the debugger's session tree at Tracing.start.
      // Attach existing pages first so their producers participate in startup.
      const own = await debuggerApi.sendCommand("Target.getTargetInfo");
      if (closed) return;
      ownTargetId = own.targetInfo.targetId;
      trackingTargets = true;
      await debuggerApi.sendCommand("Target.setDiscoverTargets", { discover: true });
      if (closed) return;
      const { targetInfos } = await debuggerApi.sendCommand("Target.getTargets");
      await Promise.allSettled((targetInfos as TargetInfo[]).map(attach));
      if (closed) return;
      await debuggerApi.sendCommand("Tracing.start", {
        transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
        traceConfig: config,
      });
      started = !closed;
    },

    async *read(signal: AbortSignal): AsyncIterable<ChromiumTraceChunk> {
      if (closed || !started) throw new Error("Chromium trace session is not recording");
      started = false;
      trackingTargets = false;
      await debuggerApi.sendCommand("Tracing.end");
      const handle = await completion;
      if (!handle) throw new Error("Chromium trace stream unavailable");
      try {
        for (let reads = 0; reads < MAX_READS; reads += 1) {
          signal.throwIfAborted();
          const chunk = await debuggerApi.sendCommand("IO.read", { handle, size: READ_BYTES });
          if (typeof chunk.data !== "string" || typeof chunk.eof !== "boolean") {
            throw new Error("Invalid Chromium trace chunk");
          }
          if (chunk.data) yield { data: chunk.data, base64Encoded: chunk.base64Encoded === true };
          if (chunk.eof) return;
        }
        throw new Error("Chromium trace exceeded the read limit");
      } finally {
        if (!closed && debuggerApi.isAttached()) {
          await debuggerApi.sendCommand("IO.close", { handle });
        }
      }
    },

    dispose() {
      if (closed) return;
      closed = true;
      complete();
      debuggerApi.off("message", message);
      debuggerApi.off("detach", detached);
      if (!webContents.isDestroyed()) {
        try {
          if (debuggerApi.isAttached()) debuggerApi.detach();
        } finally {
          webContents.close();
        }
      }
    },
  };
}
