import fs, { type Stats } from "node:fs";

export type ConfigFileWatcher = Readonly<{
  close(): void;
}>;

export type ConfigFileWatcherFactory = (params: {
  configPath: string;
  onChange: () => void;
  coalesceMs?: number;
}) => ConfigFileWatcher;

export const watchConfigFile: ConfigFileWatcherFactory = (params) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const scheduleChange = (): void => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(params.onChange, params.coalesceMs ?? 50);
    timer.unref?.();
  };

  // Watch the exact path through stat polling rather than attaching a libuv
  // directory event watcher. Atomic config replacement changes the file behind
  // this path, which watchFile continues to observe. On Windows, directory
  // watchers can abort the entire Node worker in libuv when the watched
  // temporary profile directory is replaced or removed.
  const listener = (_current: Stats, _previous: Stats): void => {
    scheduleChange();
  };
  fs.watchFile(
    params.configPath,
    { interval: 250, persistent: false },
    listener,
  );
  // Reconcile once after registration. watchFile establishes its initial stat
  // baseline asynchronously, so an atomic replacement in that handoff window
  // can otherwise become the baseline and never emit a change.
  scheduleChange();

  return {
    close(): void {
      closed = true;
      clearTimeout(timer);
      fs.unwatchFile(params.configPath, listener);
    },
  };
};
