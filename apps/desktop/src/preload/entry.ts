import { hardenSubframe } from "./subframe-hardening";

/**
 * The preload of every window that loads the renderer. Electron runs it in
 * the window's subframes too (`nodeIntegrationInSubFrames`), and those frames
 * hold untrusted content such as HTML file previews. Only the window's own
 * document gets the app's bridge: `./index` is not even evaluated in a
 * subframe, so a subframe sends no IPC and holds no part of the desktop API.
 */
if (process.isMainFrame) {
  // An import would evaluate the bridge in every frame, and a sandboxed
  // preload cannot load a second file. The bundler inlines this module in
  // the same file and runs it only here.
  // eslint-disable-next-line typescript/no-require-imports
  require("./index");
} else {
  hardenSubframe();
}
