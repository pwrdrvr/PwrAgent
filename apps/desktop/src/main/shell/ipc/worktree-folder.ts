import { ipcMain } from "electron";
import type { DesktopWorktreeFolder, DesktopWorktreeFolderCheck } from "@pwragent/shared/contracts/settings";
import { SETTINGS_WORKTREE_FOLDER_CHECK_CHANNEL } from "../../../shared/ipc";
import { checkWorktreeFolder } from "../../settings/worktree-folder-check";

/**
 * Checks the configured worktree folder. The folder comes from settings, never
 * from the renderer, so this cannot probe arbitrary paths.
 */
export function registerWorktreeFolderIpc(
  resolveWorktreeFolder: () => DesktopWorktreeFolder | undefined,
): void {
  ipcMain.removeHandler(SETTINGS_WORKTREE_FOLDER_CHECK_CHANNEL);
  ipcMain.handle(SETTINGS_WORKTREE_FOLDER_CHECK_CHANNEL, async (): Promise<DesktopWorktreeFolderCheck> => {
    const directory = resolveWorktreeFolder()?.directory;
    return directory ? { directory, status: await checkWorktreeFolder(directory) } : {};
  });
}
