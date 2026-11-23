let pending = 0;
let held = false;

export function beginUpdateBlockingWork(): () => void {
  if (held) throw new Error("PwrAgent is restarting. Retry after it relaunches.");
  pending += 1;
  return () => { pending -= 1; };
}

export function pendingUpdateBlockingWork(): number {
  return pending;
}

export function updateBlockingWorkIsHeld(): boolean {
  return held;
}

export function holdUpdateBlockingWork(): (() => void) | undefined {
  if (held || pending > 0) return undefined;
  held = true;
  return () => { held = false; };
}
