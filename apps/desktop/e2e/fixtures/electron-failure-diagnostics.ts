import type { TestInfo } from "@playwright/test";

/** Keep pre-close snapshots in memory until Playwright knows the attempt's outcome. */
export class ElectronFailureDiagnostics {
  private readonly captures: Array<() => Promise<unknown>> = [];

  register(read: () => Promise<unknown>): () => Promise<unknown> {
    let snapshot: Promise<unknown> | undefined;
    const capture = () => snapshot ??= Promise.resolve().then(read).catch(() => ({ unavailable: "evaluation-failed" }));
    this.captures.push(capture);
    return capture;
  }

  async attach(testInfo: Pick<TestInfo, "status" | "attach">): Promise<void> {
    if (testInfo.status !== "failed" && testInfo.status !== "timedOut" && testInfo.status !== "interrupted") return;
    for (const [index, capture] of this.captures.entries()) {
      const snapshot = await capture();
      if (snapshot === undefined) continue;
      await testInfo.attach(`main-process-timing-${index + 1}.json`, {
        body: JSON.stringify(snapshot, null, 2),
        contentType: "application/json",
      });
    }
  }
}
