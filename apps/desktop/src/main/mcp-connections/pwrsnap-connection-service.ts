import { homedir } from "node:os";
import { join } from "node:path";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { LocalMcpConnectionService, type LocalMcpConnectionServiceOptions } from "./local-mcp-connection-service";
export type { McpConnectionBridgeRegistration, McpConnectionBridgeServer } from "./local-mcp-connection-service";
export const PWRSNAP_SESSION_REVOKED_ERROR = "PwrSnap revoked this connection. PwrSnap tools stay unavailable until the operator chooses Connect to PwrSnap in PwrAgent.";

type Settings = Pick<ReturnType<typeof getDesktopSettingsService>,
  "clearPwrSnapMcpCredential" | "resolvePwrSnapMcpCredential" | "savePwrSnapMcpCredential">;
export type PwrSnapConnectionServiceOptions = Omit<LocalMcpConnectionServiceOptions<"pwrsnap">,
  "connectionId" | "displayName" | "endpoint" | "scopes" | "downloadUrl" | "settings"> & { settings?: Settings };

function resolveDefaultPwrSnapInstallPaths(): string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/PwrSnap.app",
      join(homedir(), "Applications", "PwrSnap.app"),
    ];
  }
  if (process.platform === "win32") {
    return [
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, "Programs", "PwrSnap", "PwrSnap.exe")
        : "",
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, "PwrSnap", "PwrSnap.exe")
        : "",
      process.env["ProgramFiles(x86)"]
        ? join(process.env["ProgramFiles(x86)"]!, "PwrSnap", "PwrSnap.exe")
        : "",
    ].filter(Boolean);
  }
  return [
    "/usr/bin/pwrsnap",
    "/opt/PwrSnap/pwrsnap",
    join(homedir(), "Applications", "PwrSnap.AppImage"),
  ];
}

export class PwrSnapConnectionService extends LocalMcpConnectionService<"pwrsnap"> {
  constructor(options: PwrSnapConnectionServiceOptions = {}) {
    // Resolve the singleton lazily: IPC handlers can be registered before settings initialize.
    const settings = () => options.settings ?? getDesktopSettingsService();
    super({
      ...options,
      connectionId: "pwrsnap",
      displayName: "PwrSnap",
      endpoint: new URL("http://127.0.0.1:51729/mcp"),
      scopes: "library.read capture.composite.read capture.original.read capture.export capture.edit trash.write sizzle.compose sizzle.preview.read sizzle.full.read",
      downloadUrl: "https://github.com/pwrdrvr/PwrSnap/releases/latest",
      resolveInstallPaths: options.resolveInstallPaths ?? resolveDefaultPwrSnapInstallPaths,
      settings: {
        clearCredential: async () => await settings().clearPwrSnapMcpCredential(),
        resolveCredential: async () => await settings().resolvePwrSnapMcpCredential(),
        saveCredential: async (value) => await settings().savePwrSnapMcpCredential(value),
      },
    });
  }
}

let service: PwrSnapConnectionService | undefined;
export function getPwrSnapConnectionService(): PwrSnapConnectionService {
  service ??= new PwrSnapConnectionService();
  return service;
}

export async function resetPwrSnapConnectionServiceForTests(): Promise<void> {
  await service?.close();
  service = undefined;
}
