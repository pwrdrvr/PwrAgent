import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createUsageActivityFocusSubscription } from "../usage-activity-focus";
import { USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL } from "../../shared/ipc";

describe("Usage Activity focus requests", () => {
  it("keeps the newest request that arrives before the window subscribes", () => {
    const emitter = new EventEmitter();
    const subscribe = createUsageActivityFocusSubscription(emitter as unknown as IpcRenderer);
    const send = (provider: unknown) => emitter.emit(USAGE_ACTIVITY_FOCUS_PROVIDER_EVENT_CHANNEL, {}, provider);
    send("anthropic");
    send("openai");
    send(42);
    const callback = vi.fn();
    const unsubscribe = subscribe(callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith("openai");
    send("xai");
    expect(callback).toHaveBeenLastCalledWith("xai");
    unsubscribe();
    send("anthropic");
    expect(callback).toHaveBeenCalledTimes(2);
    // A later subscriber is handed the request nobody received, once.
    const later = vi.fn();
    subscribe(later);
    subscribe(vi.fn());
    expect(later).toHaveBeenCalledExactlyOnceWith("anthropic");
  });
});
