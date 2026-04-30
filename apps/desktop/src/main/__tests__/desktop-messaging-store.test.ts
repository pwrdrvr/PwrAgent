import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../messaging/core/messaging-store", () => ({
  MessagingStore: class MockMessagingStore {
    constructor(readonly filePath: string) {}
  },
}));

describe("desktop messaging store", () => {
  const originalStateRoot = process.env.PWRAGNT_STATE_ROOT;

  afterEach(() => {
    if (originalStateRoot === undefined) {
      delete process.env.PWRAGNT_STATE_ROOT;
    } else {
      process.env.PWRAGNT_STATE_ROOT = originalStateRoot;
    }
    vi.resetModules();
  });

  it("uses the desktop state root messaging-state.json path", async () => {
    process.env.PWRAGNT_STATE_ROOT = "/tmp/pwragnt-state";
    const { getDesktopMessagingStore } = await import(
      "../messaging/desktop-messaging-store"
    );

    const store = getDesktopMessagingStore() as unknown as { filePath: string };

    expect(store.filePath).toBe("/tmp/pwragnt-state/messaging-state.json");
  });

  it("returns a singleton until reset for tests", async () => {
    process.env.PWRAGNT_STATE_ROOT = "/tmp/pwragnt-state";
    const { getDesktopMessagingStore, resetDesktopMessagingStoreForTests } =
      await import("../messaging/desktop-messaging-store");

    const first = getDesktopMessagingStore();
    expect(getDesktopMessagingStore()).toBe(first);

    resetDesktopMessagingStoreForTests();

    expect(getDesktopMessagingStore()).not.toBe(first);
  });
});
