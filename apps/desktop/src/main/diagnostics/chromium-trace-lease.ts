// Chromium has one trace session per instance, even across renderer targets.
let owner: symbol | undefined;
export function acquireChromiumTrace(): () => void {
  if (owner) throw new Error("A Chromium diagnostics capture is already active");
  const token = Symbol();
  owner = token;
  return () => { if (owner === token) owner = undefined; };
}
