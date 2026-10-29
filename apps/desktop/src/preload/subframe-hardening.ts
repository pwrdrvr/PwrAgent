import { contextBridge } from "electron";

/**
 * Hardens a frame below a window's own document before any of its scripts
 * run.
 *
 * HTML file previews run the page's scripts in a sandboxed `srcdoc` frame.
 * Its Content-Security-Policy keeps fetch, images and sockets inside the
 * frame, but no policy covers WebRTC: an ICE server or a remote candidate
 * carries data out as STUN packets and DNS lookups. Removing the
 * constructors from the preview's own window is not enough, because the page
 * can nest frames. A nested `srcdoc` frame inherits the sandbox and the
 * policy, gets a window of its own, and runs its own inline script there.
 * Electron runs this preload in every frame of the window
 * (`nodeIntegrationInSubFrames`), nested ones included, before the frame's
 * first script, so every window the page can make is covered.
 *
 * A `javascript:` URL also gives a nested frame a new document, and Electron
 * runs no preload for it. The preview's script policy requires Trusted Types
 * for that reason: the default policy installed here passes every string
 * through unchanged except a `javascript:` navigation, which it refuses. A
 * frame that has no policy refuses the navigation as well.
 *
 * The window's own document keeps WebRTC; native voice uses it.
 */
export function hardenSubframe(): void {
  try {
    contextBridge.executeInMainWorld({ func: hardenMainWorld });
  } catch {
    // A frame whose scripts are off has no main world to reach, and needs none.
  }
}

// Electron serializes this function into the frame: it must not refer to
// anything outside its own body.
function hardenMainWorld(): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel"]) {
    try {
      Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
    } catch {
      // Already locked down by an earlier pass over this window.
    }
  }
  try {
    window.trustedTypes?.createPolicy("default", {
      createHTML: (value: string) => value,
      createScriptURL: (value: string) => value,
      createScript: (value: string, _type: unknown, sink: unknown) =>
        sink === "Location href" ? null : value,
    });
  } catch {
    // The frame's own policy forbids a default policy; Trusted Types then
    // refuses every string sink there, `javascript:` navigations included.
  }
}
