import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { createPlainTextPasteSubscription } from "../plain-text-paste";
import { PASTE_WITHOUT_FORMATTING_CHANNEL, PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL } from "../../shared/plain-text-paste";

it("dispatches once to a claiming composer or falls back exactly once regardless of inactive composer count", () => {
  fc.assert(fc.property(fc.array(fc.boolean()), fc.string(), (claims, text) => {
    const ipc = Object.assign(new EventEmitter(), { send: vi.fn() });
    const subscribe = createPlainTextPasteSubscription(ipc as unknown as IpcRenderer);
    const callbacks = claims.map((claim) => vi.fn(() => claim));
    const unsubscribe = callbacks.map(subscribe);
    ipc.emit(PASTE_WITHOUT_FORMATTING_CHANNEL, {}, text);
    const firstClaim = claims.indexOf(true);
    callbacks.forEach((callback, index) => {
      expect(callback).toHaveBeenCalledTimes(firstClaim === -1 || index <= firstClaim ? 1 : 0);
    });
    expect(ipc.send).toHaveBeenCalledTimes(firstClaim === -1 ? 1 : 0);
    unsubscribe.forEach((remove) => remove());
    ipc.send.mockClear();
    ipc.emit(PASTE_WITHOUT_FORMATTING_CHANNEL, {}, text);
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith(PASTE_WITHOUT_FORMATTING_FALLBACK_CHANNEL);
  }));
});
