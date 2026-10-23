import { describe, expect, it, vi } from "vitest";
import type { ComposerFilePushProgress, PushComposerFileResult } from "@pwragent/shared";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: vi.fn() }));

const { createComposerFilePushController } = await import("../ipc/federation-composer-file-push");
const { FEDERATION_COMPOSER_FILE_PUSH_PROGRESS_CHANNEL } = await import("../../shared/ipc");

const target = { scope: "remote" as const, instanceId: "pwr_owner" };

function sender(id = 1) {
  const destroyedListeners: Array<() => void> = [];
  const sent: ComposerFilePushProgress[] = [];
  return {
    id,
    sent,
    destroy: () => destroyedListeners.forEach((listener) => listener()),
    isDestroyed: () => false,
    send: (channel: string, progress: ComposerFilePushProgress) => {
      expect(channel).toBe(FEDERATION_COMPOSER_FILE_PUSH_PROGRESS_CHANNEL);
      sent.push(progress);
    },
    once: (_event: "destroyed", listener: () => void) => {
      destroyedListeners.push(listener);
    },
  };
}

const result: PushComposerFileResult = { path: "/owner/Downloads/a.txt", sizeBytes: 3, sha256: "x" };

describe("composer file push IPC", () => {
  it("rejects requests that do not name a remote target and an absolute path", async () => {
    const push = vi.fn(async () => result);
    const controller = createComposerFilePushController({ push });
    for (const request of [
      { uploadId: "u", target: { scope: "local" }, sourcePath: "/a.txt" },
      { uploadId: "u", target: { scope: "remote", instanceId: "no spaces allowed" }, sourcePath: "/a.txt" },
      { uploadId: "u", target, sourcePath: "relative/a.txt" },
      { uploadId: "", target, sourcePath: "/a.txt" },
    ]) {
      await expect(controller.push(sender(), request as never)).rejects.toThrow("Invalid file upload request.");
    }
    expect(push).not.toHaveBeenCalled();
  });

  it("throttles progress to the requesting window but always sends the first and last update", async () => {
    let clock = 0;
    const push = vi.fn(async (_request, options: { onProgress?: (sent: number, total: number) => void }) => {
      options.onProgress?.(0, 300);
      clock += 10;
      options.onProgress?.(100, 300);
      clock += 200;
      options.onProgress?.(200, 300);
      clock += 10;
      options.onProgress?.(300, 300);
      return result;
    });
    const window = sender();
    const controller = createComposerFilePushController({ push, now: () => clock });
    await expect(controller.push(window, { uploadId: "u1", target, sourcePath: "/a.txt" })).resolves.toEqual(result);
    expect(window.sent.map((progress) => progress.sentBytes)).toEqual([0, 200, 300]);
    expect(window.sent.every((progress) => progress.uploadId === "u1")).toBe(true);
  });

  it("aborts only the cancelling window's upload, and every upload of a closed window", async () => {
    const signals = new Map<string, AbortSignal>();
    const push = vi.fn((request: { uploadId: string }, options: { signal?: AbortSignal }) => {
      signals.set(request.uploadId, options.signal!);
      return new Promise<PushComposerFileResult>(() => undefined);
    });
    const controller = createComposerFilePushController({ push });
    const first = sender(1);
    const second = sender(2);
    void controller.push(first, { uploadId: "a", target, sourcePath: "/a.txt" });
    void controller.push(first, { uploadId: "b", target, sourcePath: "/b.txt" });
    void controller.push(second, { uploadId: "c", target, sourcePath: "/c.txt" });

    controller.cancel(2, { uploadId: "a" });
    expect(signals.get("a")?.aborted).toBe(false);
    controller.cancel(1, { uploadId: "a" });
    expect(signals.get("a")?.aborted).toBe(true);

    first.destroy();
    expect(signals.get("b")?.aborted).toBe(true);
    expect(signals.get("c")?.aborted).toBe(false);
  });
});
