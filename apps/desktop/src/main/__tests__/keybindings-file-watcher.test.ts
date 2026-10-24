import fs, { type PathLike, type Stats, type StatWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readKeybindingsFile, watchKeybindingsFile } from "../keybindings/keybindings-store";

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

let root: string;
let filePath: string;
let listeners: Array<(current: Stats, previous: Stats) => void>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-keybindings-watch-"));
  filePath = path.join(root, "keybindings.toml");
  listeners = [];
  vi.useFakeTimers();
  // Simulate the initial stat adopting an immediate save as its baseline:
  // no filesystem change callback is delivered for that save.
  const watchImplementation = (
    _filename: PathLike,
    _options: { interval?: number; persistent?: boolean },
    listener: (current: Stats, previous: Stats) => void,
  ): StatWatcher => {
    listeners.push(listener);
    return {} as StatWatcher;
  };
  vi.spyOn(fs, "watchFile").mockImplementation(watchImplementation as typeof fs.watchFile);
  vi.spyOn(fs, "unwatchFile").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("keybindings file watcher", () => {
  it("reconciles an immediate atomic save even when registration emits no change", () => {
    fs.writeFileSync(filePath, '[threads]\nrename = ["F2"]\n');
    const onChange = vi.fn(() => readKeybindingsFile(filePath).overrides);
    const watcher = watchKeybindingsFile(filePath, onChange, { debounceMs: 10 });
    try {
      fs.writeFileSync(`${filePath}.tmp`, '[threads]\nrename = ["F3"]\n');
      fs.renameSync(`${filePath}.tmp`, filePath);
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(onChange).toHaveReturnedWith({ "threads.rename": ["F3"] });
      expect(fs.watchFile).toHaveBeenCalledWith(
        filePath,
        { interval: 250, persistent: false },
        expect.any(Function),
      );
    } finally {
      watcher.close();
    }
  });

  it("coalesces changes and cancels pending and late callbacks on close", () => {
    const onChange = vi.fn();
    const watcher = watchKeybindingsFile(filePath, onChange, { debounceMs: 10 });
    try {
      const listener = listeners[0];
      vi.advanceTimersByTime(10);
      expect(onChange).toHaveBeenCalledOnce();

      listener({} as Stats, {} as Stats);
      vi.advanceTimersByTime(5);
      listener({} as Stats, {} as Stats);
      vi.advanceTimersByTime(5);
      expect(onChange).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(5);
      expect(onChange).toHaveBeenCalledTimes(2);

      listener({} as Stats, {} as Stats);
      watcher.close();
      listener({} as Stats, {} as Stats);
      vi.advanceTimersByTime(10);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(fs.unwatchFile).toHaveBeenCalledWith(filePath, listener);
    } finally {
      watcher.close();
    }
  });

  it("closes only its own listener when two owners watch the shared file", () => {
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    const first = watchKeybindingsFile(filePath, firstChange);
    const second = watchKeybindingsFile(filePath, secondChange);
    try {
      const firstListener = listeners[0];
      const secondListener = listeners[1];
      first.close();
      expect(fs.unwatchFile).toHaveBeenCalledWith(filePath, firstListener);
      expect(fs.unwatchFile).not.toHaveBeenCalledWith(filePath, secondListener);
      firstListener({} as Stats, {} as Stats);
      secondListener({} as Stats, {} as Stats);
      vi.advanceTimersByTime(120);
      expect(firstChange).not.toHaveBeenCalled();
      expect(secondChange).toHaveBeenCalledOnce();
    } finally {
      first.close();
      second.close();
    }
  });
});
