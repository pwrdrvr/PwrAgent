import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type TestInfo } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const fixturePath = path.resolve(import.meta.dirname, "fixtures/smoke/replay.fixture.json");

test.describe("main-process timing attachments", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  let failedAttempt: TestInfo;
  let passingAttempt: TestInfo;

  test("retains timing when an assertion fails before finally closes Electron", async () => {
    failedAttempt = test.info();
    const app = await launchElectronApp({ fixturePath });
    test.fail();
    try {
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
    expect(snapshot.listings).toMatchObject({ schemaVersion: 1, capacity: 4096, retentionMs: 120_000 });
    expect(Array.isArray(snapshot.listings.events)).toBe(true);
    expect(snapshot.git).toMatchObject({ schemaVersion: 1, retentionMs: 120_000 });
    expect(Array.isArray(snapshot.git.buckets)).toBe(true);
    const app = await launchElectronApp({ fixturePath });
    await app.close();
  });

  test.afterAll(() => {
    expect(passingAttempt.attachments.filter((item) => item.name.startsWith("main-process-timing-"))).toHaveLength(0);
  });
});
