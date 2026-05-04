import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDesktopMessagingStore, resetDesktopMessagingStoreForTests, setDesktopMessagingStoreForTests } from "../messaging/desktop-messaging-store";
import { initializeAppState, resetAppStateForTests } from "../state/app-state";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("desktop messaging store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-msg-store-test-"));
    process.env.PWRAGENT_HOME = tmpDir;
    initializeAppState();
  });

  afterEach(() => {
    resetDesktopMessagingStoreForTests();
    resetAppStateForTests();
    delete process.env.PWRAGENT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the app messaging store by default", () => {
    const store = getDesktopMessagingStore();
    expect(store).toBeDefined();
    expect(store).toBe(getDesktopMessagingStore());
  });

  it("allows overriding with setDesktopMessagingStoreForTests", () => {
    const original = getDesktopMessagingStore();
    const fake = {} as ReturnType<typeof getDesktopMessagingStore>;
    setDesktopMessagingStoreForTests(fake);
    expect(getDesktopMessagingStore()).toBe(fake);
    resetDesktopMessagingStoreForTests();
    expect(getDesktopMessagingStore()).toBe(original);
  });
});
