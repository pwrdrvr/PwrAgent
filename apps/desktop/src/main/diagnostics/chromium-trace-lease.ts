// Chromium has one trace session per instance, even across renderer targets.
let owner: symbol | undefined;
const releaseListeners = new Set<() => void>();

export function tryAcquireChromiumTrace(): (() => void) | undefined {
  if (owner) return;
  const token = Symbol();
  owner = token;
  return () => {
    if (owner !== token) return;
    owner = undefined;
    for (const listener of [...releaseListeners]) listener();
  };
}

export function acquireChromiumTrace(): () => void {
  const release = tryAcquireChromiumTrace();
  if (!release) throw new Error("A Chromium diagnostics capture is already active");
  return release;
}

export function onChromiumTraceReleased(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => { releaseListeners.delete(listener); };
}
