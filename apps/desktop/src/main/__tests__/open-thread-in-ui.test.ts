import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import type { OperatorFocusSnapshot } from "@pwragent/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenThreadInUi } from "../native-voice/open-thread-in-ui";
import { publishOperatorFocus, resetOperatorFocusRegistry } from "../native-voice/operator-focus-registry";

vi.mock("../primary-main-window", () => ({ primaryMainWindowWebContents: () => undefined }));
vi.mock("../window-show-thread", () => ({ requestShowThread: vi.fn() }));

function windowContents(id = 1): WebContents {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents;
}

const args = { backend: "codex" as const, threadId: "requested" };
const focus: OperatorFocusSnapshot = { view: "thread", thread: { ...args, title: "Requested thread" } };

function setup() {
  const webContents = windowContents();
  const send = vi.fn(() => webContents);
  const open = createOpenThreadInUi({ window: () => webContents, send, localInstanceId: async () => "this-machine", timeoutMs: 100 });
  return { webContents, send, open };
}

beforeEach(() => { resetOperatorFocusRegistry(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("open_thread in the graphical main window", () => {
  it("fails when no graphical window is available", async () => {
    const open = createOpenThreadInUi({ localInstanceId: async () => "local" });
    expect(await open(args)).toMatchObject({ ok: false, error: { code: "ui_not_available" } });
  });

  it("targets the local main window whose operator focus was most recently published", async () => {
    const first = windowContents(1);
    const latest = windowContents(2);
    publishOperatorFocus({ webContents: first, focus: { view: "settings" }, now: 1 });
    publishOperatorFocus({ webContents: latest, focus: { view: "thread" }, now: 2 });
    const send = vi.fn(() => latest);
    const open = createOpenThreadInUi({ send, localInstanceId: async () => "local" });
    const result = open(args);
    expect(send).toHaveBeenCalledWith(args, { preferWebContents: latest, requirePreferred: true });
    publishOperatorFocus({ webContents: latest, focus });
    expect((await result).ok).toBe(true);
  });

  it("waits for this window's matching view and thread, rather than claiming dispatch opened it", async () => {
    const { open, send, webContents } = setup();
    const done = vi.fn();
    const result = open(args).then((response) => { done(); return response; });
    expect(send).toHaveBeenCalledWith(args, { preferWebContents: webContents, requirePreferred: true });
    publishOperatorFocus({ webContents: windowContents(2), focus });
    publishOperatorFocus({ webContents, focus: { ...focus, view: "settings" } });
    publishOperatorFocus({ webContents, focus: { view: "thread", thread: { ...args, threadId: "other", title: "Other" } } });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    publishOperatorFocus({ webContents, focus });
    expect(await result).toEqual({ ok: true, data: { focus } });
    expect(webContents.listenerCount("destroyed")).toBe(1); // Registry owns the remaining listener.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mounts a peer in this machine's window and requires the owning instance in the acknowledgement", async () => {
    const { open, send, webContents } = setup();
    const result = open({ ...args, instanceId: "peer" });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({ ...args, federationTarget: { scope: "remote", instanceId: "peer" } }, expect.anything());
    publishOperatorFocus({ webContents, focus });
    const peerFocus = { ...focus, thread: { ...focus.thread!, instanceId: "peer" } };
    publishOperatorFocus({ webContents, focus: peerFocus });
    expect(await result).toEqual({ ok: true, data: { focus: peerFocus } });
  });

  it("accepts the local instanceId but requires a fresh publication even for the already selected thread", async () => {
    const { open, send, webContents } = setup();
    publishOperatorFocus({ webContents, focus });
    const done = vi.fn();
    const result = open({ ...args, instanceId: "this-machine" }).then((response) => { done(); return response; });
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    publishOperatorFocus({ webContents, focus });
    expect(await result).toEqual({ ok: true, data: { focus } });
    expect(send).toHaveBeenCalledWith(args, expect.anything());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports unconfirmed navigation and cleans up on timeout", async () => {
    const { open, webContents } = setup();
    const result = open(args);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({ ok: false, error: { code: "navigation_timeout" } });
    expect(webContents.listenerCount("destroyed")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when the window closes or stops subscribing", async () => {
    const { open, send, webContents } = setup();
    const result = open(args);
    webContents.emit("destroyed");
    expect(await result).toMatchObject({ ok: false, error: { code: "ui_not_available" } });
    send.mockReturnValue(undefined as never);
    expect(await open(args)).toMatchObject({ ok: false, error: { code: "ui_not_available" } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles and cleans up when dispatch throws", async () => {
    const { open, send } = setup();
    send.mockImplementation(() => { throw new Error("window unavailable"); });
    expect(await open(args)).toMatchObject({ ok: false, error: { code: "internal_error", message: "window unavailable" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
