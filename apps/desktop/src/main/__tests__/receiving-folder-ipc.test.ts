import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceivingFolderRequest, ReceivingFolderResponse } from "../../shared/federation-receiving-folder";
import { SETTINGS_RECEIVING_FOLDER_CHANNEL } from "../../shared/ipc";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, request: ReceivingFolderRequest) => Promise<ReceivingFolderResponse>>(),
  getPath: vi.fn(),
  fromWebContents: vi.fn(),
  showOpenDialog: vi.fn(),
  openPath: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: mocks.getPath },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  shell: { openPath: mocks.openPath, openExternal: mocks.openExternal },
  ipcMain: {
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
    handle: (channel: string, handler: (event: unknown, request: ReceivingFolderRequest) => Promise<ReceivingFolderResponse>) => mocks.handlers.set(channel, handler),
  },
}));
import { registerReceivingFolderIpc } from "../ipc/receiving-folder";

describe("receiving folder settings IPC", () => {
  let directory: string;
  const sender = {};
  const invoke = (request: ReceivingFolderRequest) => mocks.handlers.get(SETTINGS_RECEIVING_FOLDER_CHANNEL)!({ sender }, request);
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-receiving-ipc-"));
    mocks.getPath.mockReturnValue(directory);
    mocks.openPath.mockResolvedValue("");
    registerReceivingFolderIpc();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("inspects the Downloads default without requesting filesystem access", async () => {
    expect(await invoke({ action: "inspect" })).toMatchObject({ directory, privacyPermission: "unknown" });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("checks writes without changing incoming-file consent or claiming privacy authorization", async () => {
    expect(await invoke({ action: "check", directory })).toMatchObject({ directory, privacyPermission: "unknown", access: { status: "writable" } });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("anchors Browse to the requesting window and returns the folder without saving consent", async () => {
    const window = {};
    mocks.fromWebContents.mockReturnValueOnce(window);
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [directory] });
    expect(await invoke({ action: "browse" })).toMatchObject({ directory, privacyPermission: "unknown" });
    expect(mocks.fromWebContents).toHaveBeenCalledWith(sender);
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({ defaultPath: directory, properties: ["openDirectory", "createDirectory"], title: "Choose incoming files folder" }));
  });

  it("treats Browse cancellation as a no-op", async () => {
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke({ action: "browse", directory })).toMatchObject({ canceled: true, directory });
  });

  it.each(["darwin", "win32", "linux"])("opens the chosen folder in the OS file manager (%s)", async (platform) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    await invoke({ action: "reveal", directory });
    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith(directory);
  });

  it("reports file-manager failures", async () => {
    mocks.openPath.mockResolvedValueOnce("No file manager available");
    await expect(invoke({ action: "reveal", directory })).rejects.toThrow("No file manager available");
  });

  it("opens only the main-owned Files & Folders URL on macOS", async () => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: "darwin" } }));
    expect(await invoke({ action: "privacy" })).toMatchObject({ privacySettingsSupported: true, privacyPermission: "unknown" });
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith("x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders");
  });

  it.each(["win32", "linux"])("does not offer a misleading privacy screen on %s", async (platform) => {
    vi.stubGlobal("process", Object.create(process, { platform: { value: platform } }));
    expect(await invoke({ action: "inspect" })).toMatchObject({ privacySettingsSupported: false });
    await expect(invoke({ action: "privacy" })).rejects.toThrow("macOS only");
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it("rejects relative paths, arbitrary actions, and non-folders before launching an app", async () => {
    await expect(invoke({ action: "reveal", directory: "relative" })).rejects.toThrow("absolute path");
    await expect(invoke({ action: "untrusted-url" } as unknown as ReceivingFolderRequest)).rejects.toThrow("Invalid");
    const file = path.join(directory, "file");
    await fs.writeFile(file, "");
    await expect(invoke({ action: "reveal", directory: file })).rejects.toThrow("not a folder");
    expect(mocks.openPath).not.toHaveBeenCalled();
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });
});
