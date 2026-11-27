import { applicationHost } from "../owner-host.js";

const DEVELOPMENT_VERSION = "0.0.0";

export function readAcpClientInfo(): { name: string; title: string; version: string } {
  const packaged = applicationHost.isPackaged;
  const version = packaged ? applicationHost.getVersion().trim() : DEVELOPMENT_VERSION;
  if (packaged && (!version || version === DEVELOPMENT_VERSION)) {
    throw new Error("Packaged PwrAgent is missing its release version for ACP.");
  }
  return { name: "pwragent", title: "PwrAgent", version };
}
