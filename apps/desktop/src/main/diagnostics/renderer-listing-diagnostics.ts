import type { HotCpuTarget } from "./hot-cpu-profiler";
import { listingDiagnostics } from "./listing-diagnostics";

/** One bounded CDP read per saved profile, never on the event/IPC hot path. */
export async function readRendererListingDiagnostics(target: HotCpuTarget): Promise<Record<string, unknown>> {
  const listings = listingDiagnostics.snapshot();
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
