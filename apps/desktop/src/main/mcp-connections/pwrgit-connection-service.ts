import { homedir } from "node:os";
import { join } from "node:path";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { LocalMcpConnectionService, type LocalMcpConnectionServiceOptions } from "./local-mcp-connection-service";

type Settings = Pick<ReturnType<typeof getDesktopSettingsService>,
  "clearPwrGitMcpCredential" | "resolvePwrGitMcpCredential" | "savePwrGitMcpCredential">;
export type PwrGitConnectionServiceOptions = Omit<LocalMcpConnectionServiceOptions<"pwrgit">,
  "connectionId" | "displayName" | "endpoint" | "scopes" | "downloadUrl" | "settings"> & { settings?: Settings };

function resolveDefaultPwrGitInstallPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/PwrGit.app",
      join(homedir(), "Applications", "PwrGit.app"),
    ];
  }
  if (process.platform === "win32") {
    return [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "PwrGit", "PwrGit.exe")
        : "",
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "PwrGit", "PwrGit.exe")
        : "",
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"]!, "PwrGit", "PwrGit.exe")
        : "",
    ].filter(Boolean);
  }
  return [
    "/usr/bin/pwrgit",
    "/opt/PwrGit/pwrgit",
    join(homedir(), "Applications", "PwrGit.AppImage"),
  ];
}

export class PwrGitConnectionService extends LocalMcpConnectionService<"pwrgit"> {
  constructor(options: PwrGitConnectionServiceOptions = {}) {
    // Resolve the singleton lazily: IPC handlers can be registered before settings initialize.
    const settings = () => options.settings ?? getDesktopSettingsService();
    super({
      ...options,
      connectionId: "pwrgit",
      displayName: "PwrGit",
      verifyResourceMetadata: true,
      endpoint: new URL("http://127.0.0.1:51731/mcp"),
      scopes: "repository.roots.read repository.checkout.locate repository.metadata.read forge.status.read status.subscribe",
      downloadUrl: "https://github.com/pwrdrvr/PwrGit/releases/latest",
      resolveInstallPaths: options.resolveInstallPaths ?? resolveDefaultPwrGitInstallPaths,
      settings: {
        clearCredential: async () => await settings().clearPwrGitMcpCredential(),
        resolveCredential: async () => await settings().resolvePwrGitMcpCredential(),
        saveCredential: async (value) => await settings().savePwrGitMcpCredential(value),
      },
    });
  }
}

let service: PwrGitConnectionService | undefined;
export function getPwrGitConnectionService(): PwrGitConnectionService {
  service ??= new PwrGitConnectionService();
  return service;
}
