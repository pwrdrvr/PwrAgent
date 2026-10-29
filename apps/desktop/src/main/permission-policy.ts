import type { Session, WebContents } from "electron";
import { getMainLogger } from "./log";
import { isAppRendererUrl, type RendererEntry } from "./renderer-entry-url";

type PermissionCheckHandler = NonNullable<
  Parameters<Session["setPermissionCheckHandler"]>[0]
>;
type PermissionRequestHandler = NonNullable<
  Parameters<Session["setPermissionRequestHandler"]>[0]
>;
export type PermissionCheckDetails = Parameters<PermissionCheckHandler>[3];
export type PermissionRequestDetails = Parameters<PermissionRequestHandler>[3];

/** Media decisions belong to native voice. This module only routes to them. */
export interface MediaPermissionRules {
  check(contents: WebContents, details: PermissionCheckDetails): boolean;
  request(contents: WebContents, details: PermissionRequestDetails): boolean;
}

/**
 * Permissions the app's own top-level renderer document uses directly.
 *
 * Clipboard writes normally go through the `copyText` IPC. The renderer
 * falls back to `navigator.clipboard.write*` when that fails, and copies
 * images and Mermaid source with it directly. Nothing in the renderer reads
 * the clipboard, raises web notifications (those come from the main
 * process), or uses fullscreen, geolocation, MIDI, pointer lock, HID,
 * serial, USB, or the file system access API.
 */
const APP_FRAME_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
]);

export interface PermissionPolicyOptions {
  rendererEntry: RendererEntry;
  media: MediaPermissionRules;
}

export interface PermissionPolicy {
  check: PermissionCheckHandler;
  request: PermissionRequestHandler;
}

/**
 * Deny by default. A permission is granted only to the app's own renderer
 * document in a window's main frame. Subframes, including the opaque-origin
 * `srcdoc` iframe that runs interactive SVG scripts, get nothing.
 */
export function createPermissionPolicy(
  options: PermissionPolicyOptions,
): PermissionPolicy {
  const log = getMainLogger("pwragent:permissions");

  const fromAppFrame = (isMainFrame: boolean, requestingUrl: string | undefined) =>
    isMainFrame && isAppRendererUrl(requestingUrl, options.rendererEntry);

  const check: PermissionCheckHandler = (contents, permission, _origin, details) => {
    if (!contents) {
      return false;
    }
    // A main-frame check always carries the frame's URL; fall back to the
    // window's URL only for that case.
    const requestingUrl = details.requestingUrl
      ?? (details.isMainFrame ? contents.getURL() : undefined);
    if (!fromAppFrame(details.isMainFrame, requestingUrl)) {
      return false;
    }
    if (permission === "media") {
      return options.media.check(contents, details);
    }
    return APP_FRAME_PERMISSIONS.has(permission);
  };

  const request: PermissionRequestHandler = (contents, permission, callback, details) => {
    let granted = false;
    if (fromAppFrame(details.isMainFrame, details.requestingUrl)) {
      granted = permission === "media"
        ? options.media.request(contents, details)
        : APP_FRAME_PERMISSIONS.has(permission);
    }
    if (!granted && permission !== "media") {
      // Media denials are routine (voice is off); anything else means a
      // frame asked for something the app never uses.
      log.warn("denied renderer permission request", {
        permission,
        isMainFrame: details.isMainFrame,
      });
    }
    callback(granted);
  };

  return { check, request };
}

/** Installs the policy on a session. Call once at startup, before any window. */
export function installPermissionPolicy(
  target: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler">,
  options: PermissionPolicyOptions,
): void {
  const policy = createPermissionPolicy(options);
  target.setPermissionCheckHandler(policy.check);
  target.setPermissionRequestHandler(policy.request);
}
