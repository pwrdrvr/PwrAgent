/** One attachment, independent exclusive CDP domains, and last-owner detach. */
export type DiagnosticDebugger = {
  attach: (version: string) => void;
  detach: () => void;
  isAttached: () => boolean;
  sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  on: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
  off?: (event: "detach", listener: (event: unknown, reason: string) => void) => void;
};

export type DebuggerLease = {
  readonly valid: boolean;
  release: (destroyed?: boolean) => void;
};

type Attachment = { domains: Set<string>; lost: boolean; onDetach: () => void };
const attachments = new WeakMap<DiagnosticDebugger, Attachment>();

// Never adopt an unknown attachment. In particular, releasing a stale lease
// must not detach a replacement connection installed after DevTools took over.
export function acquireDebuggerLease(debuggerApi: DiagnosticDebugger, domain: "Profiler" | "Tracing"): DebuggerLease {
  let attachment = attachments.get(debuggerApi);
  if (!attachment) {
    if (debuggerApi.isAttached()) throw new Error("Debugger already attached");
    debuggerApi.attach("1.3");
    attachment = { domains: new Set(), lost: false, onDetach: () => {} };
    const current = attachment;
    current.onDetach = () => {
      current.lost = true;
      if (attachments.get(debuggerApi) === current) attachments.delete(debuggerApi);
      debuggerApi.off?.("detach", current.onDetach);
    };
    attachments.set(debuggerApi, current);
    debuggerApi.on("detach", current.onDetach);
  }
  if (attachment.domains.has(domain)) throw new Error("Diagnostic domain already acquired");
  attachment.domains.add(domain);
  const current = attachment;
  let released = false;
  return {
    get valid() { return !released && !current.lost; },
    release(destroyed = false) {
      if (released) return;
      released = true;
      current.domains.delete(domain);
      if (current.lost || current.domains.size > 0) return;
      current.onDetach();
      if (!destroyed && debuggerApi.isAttached()) debuggerApi.detach();
    },
  };
}
