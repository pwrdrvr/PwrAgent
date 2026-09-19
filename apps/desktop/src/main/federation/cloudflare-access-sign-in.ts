import { shell } from "electron";
import { CloudflareAccessOAuth } from "./cloudflare-access-oauth";
import { loadCloudflareAccessSession, saveCloudflareAccessSession } from "./cloudflare-setup-storage";
import { getMainLogger } from "../log";

const log = getMainLogger("pwragent:federation-cloudflare");

let instance: CloudflareAccessOAuth | undefined;

/**
 * The one sign-in this profile holds. The runtime reads tokens from it on each
 * connection and the setup IPC drives sign-in and sign-out, so both must share
 * one instance — its single-flight refresh is what keeps a rotated refresh
 * token from being spent twice.
 */
export function getCloudflareAccessSignIn(): CloudflareAccessOAuth {
  instance ??= new CloudflareAccessOAuth({
    load: loadCloudflareAccessSession,
    save: saveCloudflareAccessSession,
    openExternal: (url) => shell.openExternal(url),
    log: (message, fields) => log.info(message, fields),
  });
  return instance;
}
