import type { HotCpuTarget } from "./hot-cpu-target";
import { listingDiagnostics } from "./listing-diagnostics";

/** Fixed scalar control for monitor start, reload and stop; no event transport. */
export async function setRendererListingDiagnosticsEnabled(target: HotCpuTarget & {
  executeJavaScript?: (expression: string) => Promise<unknown>;
}, enabled: boolean): Promise<void> {
  let clearDeadline = () => {};
  try {
    const expression = `globalThis.__pwragentSetNavigationListingDiagnosticsEnabled?.(${enabled ? "true" : "false"})`;
    await Promise.race([
      // Stop must clear the ring even if another debugger client detached CDP.
      target.executeJavaScript ? target.executeJavaScript(expression)
        : target.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true }),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        clearDeadline = () => clearTimeout(timer);
      }),
    ]);
  } finally { clearDeadline(); }
}

/** One bounded CDP read per saved profile, never on the event/IPC hot path. */
export async function readRendererListingDiagnostics(
  target: HotCpuTarget,
  listings = listingDiagnostics.snapshot(),
): Promise<Record<string, unknown>> {
  let clearDeadline = () => {};
  try {
    const response = await Promise.race([
      target.debugger.sendCommand("Runtime.evaluate", {
        expression: "globalThis.__pwragentNavigationListingDiagnostics?.() ?? null",
        returnByValue: true,
      }) as Promise<{ result?: { value?: unknown } }>,
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        clearDeadline = () => clearTimeout(timer);
      }),
    ]);
    return { listings, rendererListings: response?.result?.value ?? null };
  } catch {
    return { listings, rendererListings: null };
  } finally {
    clearDeadline();
  }
}
