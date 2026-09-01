import fs, { type FSWatcher } from "node:fs";
import path from "node:path";

export type ConfigFileWatcher = Readonly<{
  close(): void;
}>;

export type ConfigFileWatcherFactory = (params: {
  configPath: string;
  onChange: () => void;
  coalesceMs?: number;
}) => ConfigFileWatcher;

export const watchConfigFile: ConfigFileWatcherFactory = (params) => {
  const directory = path.dirname(params.configPath);
  const filename = path.basename(params.configPath);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;

  try {
    watcher = fs.watch(directory, (_eventType, changedFilename) => {
      if (changedFilename && changedFilename.toString() !== filename) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(params.onChange, params.coalesceMs ?? 50);
      timer.unref?.();
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return {
    close(): void {
      clearTimeout(timer);
      watcher?.close();
    },
  };
};
