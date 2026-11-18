import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type TestInfo } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";

const fixturePath = path.resolve(import.meta.dirname, "fixtures/smoke/replay.fixture.json");
const timedReadId = 137;

test.describe("main-process timing attachments", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  let failedAttempt: TestInfo;
  let passingAttempt: TestInfo;

  test("retains timing when an assertion fails before finally closes Electron", async () => {
    failedAttempt = test.info();
    const app = await launchElectronApp({ fixturePath });
    try {
      const protocol = await app.window.evaluate(async (logical) => {
        const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
        const page = await api.getNavigationQueryPage!({
          protocol: 2,
          consumer: "main-sidebar",
          inventory: "viewer",
          query: { kind: "lens", lens: "inbox" },
          diagnostic: { view: 0, effect: 0, logical, attempt: 1, cause: "demand", invalidations: 0 },
        }, "timing-attachment-read");
        return page.protocol;
      }, timedReadId);
      expect(protocol).toBe(2);
      test.fail();
      expect("contrived failure").toBe("passing assertion");
    } finally {
      await app.close();
    }
  });

  test("carries both owner snapshots on the failed Playwright result", async () => {
    passingAttempt = test.info();
    const attachments = failedAttempt.attachments.filter((item) => item.name.startsWith("main-process-timing-"));
    expect(attachments).toHaveLength(1);
    expect(attachments[0].contentType).toBe("application/json");
    const body = attachments[0].body ?? await readFile(attachments[0].path!);
    const snapshot = JSON.parse(body.toString("utf8"));
    expect(snapshot.listings).toMatchObject({ schemaVersion: 2, capacity: 4096, retentionMs: 120_000 });
    const start = snapshot.listings.events.find((entry: { stage: string; phase: string; logical?: number }) =>
      entry.stage === "ipc" && entry.phase === "start" && entry.logical === timedReadId);
    expect(start).toMatchObject({ query: "lens", consumer: "main-sidebar", inventory: "viewer" });
    expect(snapshot.listings.events).toContainEqual(expect.objectContaining({
      id: start.id, stage: "ipc", phase: "end", outcome: "ok",
    }));
    expect(snapshot.git).toMatchObject({ schemaVersion: 1, retentionMs: 120_000 });
    expect(Array.isArray(snapshot.git.buckets)).toBe(true);
    const app = await launchElectronApp({ fixturePath });
    await app.close();
  });

  test.afterAll(() => {
    expect(passingAttempt.attachments.filter((item) => item.name.startsWith("main-process-timing-"))).toHaveLength(0);
  });
});
