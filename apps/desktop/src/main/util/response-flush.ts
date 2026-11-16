/** A transport acknowledgement is bounded and settles once. No effect runs on failure. */
export function createResponseFlush(timeoutMs = 30_000) {
  let settle!: (error?: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    settle = (error) => { if (error) reject(error); else resolve(); };
  });
  const timer = setTimeout(() => settle(new Error("Lifecycle response acknowledgement timed out.")), timeoutMs);
  timer.unref?.();
  // Most tool calls do not schedule a lifecycle effect. Still observe failure.
  void promise.catch(() => undefined);
  let settled = false;
  return {
    promise,
    finish: (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(error);
    },
  };
}
