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

  // Watch the exact path through stat polling rather than attaching a libuv
  // directory event watcher. Atomic config replacement changes the file behind
  // this path, which watchFile continues to observe. On Windows, directory
  // watchers can abort the entire Node worker in libuv when the watched
  // temporary profile directory is replaced or removed.
  const listener = (_current: Stats, _previous: Stats): void => {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(params.onChange, params.coalesceMs ?? 50);
    timer.unref?.();
  };
  fs.watchFile(
    params.configPath,
    { interval: 250, persistent: false },
    listener,
  );

  return {
    close(): void {
      closed = true;
      clearTimeout(timer);
      fs.unwatchFile(params.configPath, listener);
    },
  };
};
