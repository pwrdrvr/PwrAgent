import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { requestPasteWithoutFormatting } from "../shell/ipc/clipboard";
import { PASTE_WITHOUT_FORMATTING_CHANNEL } from "../../shared/plain-text-paste";

const mocks = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  focusedWebContents: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: { readText: mocks.readText },
  webContents: { getFocusedWebContents: mocks.focusedWebContents },
  ClipboardItem: class {},
  ipcMain: {},
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ warn: mocks.warn }) }));

afterEach(() => { vi.unstubAllEnvs(); });

function pendingClipboardRead() {
  vi.stubEnv("PWRAGENT_E2E", "0");
  mocks.warn.mockClear();
  const read = Promise.withResolvers<string>();
  mocks.readText.mockReset().mockReturnValue(read.promise);
  const target = {
    // Electron IPC uses structured cloning, which rejects Promises. Keep
    // the real serializer as the oracle rather than accepting any payload.
    send: vi.fn((channel: string, value: unknown) => structuredClone({ channel, value })),
    isDestroyed: vi.fn(() => false),
  };
  mocks.focusedWebContents.mockReset().mockReturnValue(target);
  return { read, target };
}

it("sends only the resolved, serializable clipboard text for every clipboard string", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async (text) => {
    const { read, target } = pendingClipboardRead();
    const pending = requestPasteWithoutFormatting();
    expect(target.send).not.toHaveBeenCalled();
    read.resolve(text);
    await pending;
    expect(target.send).toHaveBeenCalledExactlyOnceWith(PASTE_WITHOUT_FORMATTING_CHANNEL, text);
    expect(mocks.warn).not.toHaveBeenCalled();
  }), { numRuns: 25 });
});

it("pastes resolved clipboard text outside E2E (Promise serialization regression)", async () => {
  const { read, target } = pendingClipboardRead();
  const pending = requestPasteWithoutFormatting();
  read.resolve("Clipboard text");
  await pending;
  expect(target.send).toHaveBeenCalledExactlyOnceWith(PASTE_WITHOUT_FORMATTING_CHANNEL, "Clipboard text");
});

it("handles a rejected clipboard read without an unhandled rejection or IPC send", async () => {
  const { read, target } = pendingClipboardRead();
  const pending = requestPasteWithoutFormatting();
  read.reject(new Error("pasteboard unavailable"));
  await expect(pending).resolves.toBeUndefined();
  expect(target.send).not.toHaveBeenCalled();
  expect(mocks.warn).toHaveBeenCalledOnce();
});

it.each(["lost focus", "destroyed"])("does not deliver clipboard text after the target %s during the read", async (change) => {
  const { read, target } = pendingClipboardRead();
  const pending = requestPasteWithoutFormatting();
  if (change === "destroyed") target.isDestroyed.mockReturnValue(true);
  else mocks.focusedWebContents.mockReturnValue({ send: vi.fn() });
  read.resolve("Clipboard text");
  await pending;
  expect(target.send).not.toHaveBeenCalled();
});
