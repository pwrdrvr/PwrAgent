import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachRendererProcessRecovery } from "../renderer-process-recovery";
import { RENDERER_RECOVERY_DELAY_MS } from "../../shared/renderer-recovery";
import { ThreadTurnQueue } from "../app-server/thread-turn-queue";

const mocks = vi.hoisted(() => ({ showMessageBox: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("../log", () => ({ getMainLogger: () => ({ info: mocks.info, error: mocks.error }) }));

function createWindow() {
  const contents = Object.assign(new EventEmitter(), {
    id: 17,
    reload: vi.fn(),
    isDestroyed: vi.fn(() => false),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: vi.fn(() => false),
  });
  attachRendererProcessRecovery(window as unknown as BrowserWindow);
  return { window, contents, crash: (reason = "crashed") => contents.emit("render-process-gone", {}, { reason, exitCode: 139 }) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("renderer process recovery", () => {
  it("leaves a running main-owned turn and its FIFO able to complete and admit the next turn", async () => {
    vi.useFakeTimers();
    const startTurn = vi.fn(async (entry) => ({ backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` }));
    const queue = new ThreadTurnQueue({ startTurn });
    const submission = { backend: "codex" as const, threadId: "one", origin: "manual" as const, input: [{ type: "text" as const, text: "work" }] };
    await expect(queue.submit({ ...submission, id: "first" })).resolves.toMatchObject({ status: "started" });
    await expect(queue.submit({ ...submission, id: "second" })).resolves.toMatchObject({ status: "queued" });
    const { crash, contents } = createWindow();
    crash();
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledTimes(1);
    await queue.releaseThread({ backend: "codex", threadId: "one", turnId: "turn-first" });
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(startTurn).toHaveBeenLastCalledWith(expect.objectContaining({ id: "second" }));
  });
  it("logs termination evidence before reloading the existing window", () => {
    vi.useFakeTimers();
    const { contents, crash } = createWindow();
    crash();
    expect(mocks.error).toHaveBeenCalledWith("renderer terminated", expect.objectContaining({
      webContentsId: 17, reason: "crashed", exitCode: 139, action: "automatic-reload", attempt: 1,
    }));
    expect(contents.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS);
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });

  it("does not reset the limit on successful loads or manual retries", async () => {
    vi.useFakeTimers();
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    const { contents, crash } = createWindow();
    for (let index = 0; index < 2; index += 1) {
      crash();
      vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS);
      contents.emit("did-finish-load");
    }
    crash("oom");
    expect(contents.reload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.reload).toHaveBeenCalledTimes(3);
    expect(mocks.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      buttons: ["Reload window", "Leave window"],
    }));
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    crash();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(contents.reload).toHaveBeenCalledTimes(3);
  });

  it("ignores clean exits and cancels retries when closed", () => {
    vi.useFakeTimers();
    const { window, contents, crash } = createWindow();
    crash("clean-exit");
    expect(vi.getTimerCount()).toBe(0);
    crash();
    window.emit("closed");
    vi.advanceTimersByTime(60_000);
    crash();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("offers native recovery when the replacement bundle fails to load", async () => {
    vi.useFakeTimers();
    mocks.showMessageBox.mockResolvedValue({ response: 1 });
    const { contents, crash } = createWindow();
    crash();
    vi.advanceTimersByTime(RENDERER_RECOVERY_DELAY_MS);
    contents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "file:///app/index.html", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1);
    expect(contents.reload).toHaveBeenCalledTimes(1);
  });
});
