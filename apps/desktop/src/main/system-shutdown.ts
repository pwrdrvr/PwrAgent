import { app, powerMonitor } from "electron";
import { getMainLogger } from "./log";

const log = getMainLogger("pwragent:main");

/** Register after app-ready, before asynchronous startup work. */
export function watchSystemShutdown(
  prepareQuit: () => void,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") return;

  let shuttingDown = false;
  // Electron's generated types omit the event documented by its shutdown API.
  powerMonitor.on("shutdown", (event?: Electron.Event) => {
    // Hold Electron's OS shutdown delay before starting cleanup. Otherwise
    // logind can kill Chromium's helpers while the browser is still alive,
    // causing fatal GPU restart attempts during power-off.
    event?.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("system shutdown requested; quitting");

    // Bound the existing resource/diagnostics drain below logind's usual
    // five-second inhibitor deadline. Only a completed quit cancels this.
    const fallback = setTimeout(() => {
      log.warn("system shutdown cleanup exceeded 3000 ms; exiting");
      app.exit(0);
    }, 3_000);
    fallback.unref();
    app.on("quit", () => clearTimeout(fallback));
    prepareQuit();
    app.quit();
  });
}
