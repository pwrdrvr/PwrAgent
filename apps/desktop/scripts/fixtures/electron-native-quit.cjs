// Standalone Electron app. No PwrAgent, Playwright, native addon, or child command.
// The driver creates --probe-root and writes its quit file after observing ready.
const { app, BrowserWindow, session } = require("electron");
const { existsSync, writeSync } = require("node:fs");
const path = require("node:path");

const root = process.argv.find((arg) => arg.startsWith("--probe-root="))?.slice(13);
if (!root || !path.isAbsolute(root)) throw new Error("An absolute --probe-root is required");
app.setPath("userData", path.join(root, "user-data"));
app.setPath("sessionData", path.join(root, "session-data"));

const record = (stage, data = {}) => {
  writeSync(1, `ELECTRON_NATIVE_QUIT ${JSON.stringify({ stage, at: Date.now(), pid: process.pid, ...data })}\n`);
};
for (const stage of ["before-quit", "will-quit", "quit"]) app.on(stage, () => record(stage));
process.on("exit", (code) => record("node-exit", { code }));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 640, height: 480 });
  await window.loadURL("data:text/html,<title>Native Electron quit probe</title><p>Ready</p>");
  const storage = session.defaultSession.storagePath;
  const relativeStorage = storage && path.relative(root, storage);
  if (!storage || relativeStorage === ".." || relativeStorage.startsWith(".." + path.sep) || path.isAbsolute(relativeStorage)) {
    throw new Error("Default session storage escaped the isolated probe root");
  }
  record("ready", { versions: process.versions, storageDirectory: relativeStorage });
  const timer = setInterval(() => {
    if (!existsSync(path.join(root, "quit"))) return;
    clearInterval(timer);
    void quit();
  }, 10);
}).catch(fail);

async function quit() {
  record("quit-received");
  try {
    if (process.argv.includes("--session-drain")) {
      record("close-connections-start");
      await session.defaultSession.closeAllConnections();
      record("close-connections-complete");
      await session.defaultSession.cookies.flushStore();
      record("flush-cookies-complete");
      await session.defaultSession.clearData({ dataTypes: ["cache"] });
      record("clear-cache-complete");
    }
    record("app-quit-requested");
    app.quit();
  } catch (error) {
    fail(error);
  }
}

function fail(error) {
  record("app-error", { message: error.message });
  app.exit(1);
}
