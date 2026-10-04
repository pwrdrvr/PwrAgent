import type { Page } from "@playwright/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { focusStarMapWindow } from "../../../e2e/fixtures/star-map-window";

const mocks = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: { poll: mocks.poll } }));

beforeEach(() => {
  mocks.poll.mockImplementation((read: () => Promise<unknown>) => ({
    toBe: async (value: unknown) => expect(await read()).toBe(value),
  }));
});

function createApp() {
  const nativeWindow = { show: vi.fn(), focus: vi.fn() };
  const nativeHandle = {
    evaluate: vi.fn(async (callback: (window: typeof nativeWindow) => void) => callback(nativeWindow)),
  };
  const browserWindow = vi.fn().mockResolvedValue(nativeHandle);
  const app = { electronApp: { browserWindow } } as unknown as Parameters<typeof focusStarMapWindow>[0];
  const page = { evaluate: vi.fn().mockResolvedValue("visible/true") } as unknown as Page;
  return { app, page, nativeWindow, nativeHandle, browserWindow };
}

const collectedPromise = () => new Error("electronApplication.browserWindow: Resulting promise was garbage collected");

describe("Star Map native focus lookup", () => {
  it("recovers a lost lookup result and focuses exactly once", async () => {
    const { app, page, nativeWindow, nativeHandle, browserWindow } = createApp();
    browserWindow.mockRejectedValueOnce(collectedPromise());
    await focusStarMapWindow(app, page);
    expect(browserWindow).toHaveBeenCalledTimes(2);
    expect(browserWindow).toHaveBeenLastCalledWith(page);
    expect(nativeHandle.evaluate).toHaveBeenCalledTimes(1);
    expect(nativeWindow.show).toHaveBeenCalledTimes(1);
    expect(nativeWindow.focus).toHaveBeenCalledTimes(1);
  });

  it("retains the failure after the bounded lookup attempts without focusing", async () => {
    const { app, page, nativeWindow, browserWindow } = createApp();
    browserWindow.mockRejectedValue(collectedPromise());
    await expect(focusStarMapWindow(app, page)).rejects.toThrow("promise was garbage collected");
    expect(browserWindow).toHaveBeenCalledTimes(2);
    expect(nativeWindow.focus).not.toHaveBeenCalled();
  });

  it("propagates a real lookup error without retrying or focusing", async () => {
    const { app, page, nativeWindow, browserWindow } = createApp();
    browserWindow.mockRejectedValue(new Error("No BrowserWindow for this Page"));
    await expect(focusStarMapWindow(app, page)).rejects.toThrow("No BrowserWindow");
    expect(browserWindow).toHaveBeenCalledTimes(1);
    expect(nativeWindow.focus).not.toHaveBeenCalled();
  });
});
