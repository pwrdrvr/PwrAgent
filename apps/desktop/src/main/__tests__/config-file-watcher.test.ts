import fs, {
  type PathLike,
  type Stats,
  type StatWatcher,
} from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchConfigFile } from "../settings/config-store/config-file-watcher";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("watchConfigFile", () => {
  it("polls the exact file and unregisters its listener before teardown", () => {
    vi.useFakeTimers();
    let listener: ((current: Stats, previous: Stats) => void) | undefined;
    const watchImplementation = (
      _filename: PathLike,
      _options: { interval?: number; persistent?: boolean },
      callback: (current: Stats, previous: Stats) => void,
    ): StatWatcher => {
      listener = callback;
      return {} as StatWatcher;
    };
    const watchFile = vi.spyOn(fs, "watchFile").mockImplementation(
      watchImplementation as typeof fs.watchFile,
    );
    const unwatchFile = vi.spyOn(fs, "unwatchFile").mockImplementation(
      () => undefined,
    );
    const onChange = vi.fn();
    const configPath = "C:\\pwragent\\profiles\\default\\config.toml";

    const watcher = watchConfigFile({ configPath, onChange });

    expect(watchFile).toHaveBeenCalledWith(
      configPath,
      { interval: 250, persistent: false },
      expect.any(Function),
    );
    listener?.({} as Stats, {} as Stats);
    vi.advanceTimersByTime(50);
    expect(onChange).toHaveBeenCalledOnce();

    watcher.close();
    expect(unwatchFile).toHaveBeenCalledWith(configPath, listener);
    listener?.({} as Stats, {} as Stats);
    vi.advanceTimersByTime(50);
    expect(onChange).toHaveBeenCalledOnce();
  });
});
