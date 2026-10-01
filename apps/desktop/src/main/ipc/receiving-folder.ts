import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { promises as fs } from "node:fs";
import type { ReceivingFolderRequest, ReceivingFolderResponse } from "../../shared/federation-receiving-folder";
import { SETTINGS_RECEIVING_FOLDER_CHANNEL } from "../../shared/ipc";
import { checkReceivingFolder, resolveReceivingFolder } from "../federation/receiving-folder-access";

// Main-owned URL: never accept a renderer-provided settings URL.
const FILES_AND_FOLDERS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

export function registerReceivingFolderIpc(): void {
  ipcMain.removeHandler(SETTINGS_RECEIVING_FOLDER_CHANNEL);
  ipcMain.handle(SETTINGS_RECEIVING_FOLDER_CHANNEL, async (event, request: ReceivingFolderRequest): Promise<ReceivingFolderResponse> => {
    if (!request || !["inspect", "check", "browse", "reveal", "privacy"].includes(request.action)
      || (request.directory !== undefined && typeof request.directory !== "string")) {
      throw new Error("Invalid incoming files folder action.");
    }
    const directory = resolveReceivingFolder(request.directory ?? "", app.getPath("downloads"));
    const response: ReceivingFolderResponse = {
      directory,
      privacySettingsSupported: process.platform === "darwin",
      privacyPermission: "unknown",
    };
    if (request.action === "inspect") return response;
    if (request.action === "check") {
      return { ...response, access: await checkReceivingFolder(directory) };
    }
    if (request.action === "browse") {
      const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options = {
        title: "Choose incoming files folder",
        buttonLabel: "Choose folder",
        defaultPath: directory,
        properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) return { ...response, canceled: true };
      return { ...response, directory: resolveReceivingFolder(result.filePaths[0], app.getPath("downloads")) };
    }
    if (request.action === "privacy") {
      if (!response.privacySettingsSupported) throw new Error("Files & Folders settings are available on macOS only. Use Browse to choose another folder or check its permissions in your file manager.");
      await shell.openExternal(FILES_AND_FOLDERS_URL);
    } else {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error("The incoming files path is not a folder.");
      // Open the folder itself in Finder, Explorer, or the default file manager.
      const error = await shell.openPath(directory);
      if (error) throw new Error(`Could not reveal the incoming files folder: ${error}`);
    }
    return response;
  });
}
