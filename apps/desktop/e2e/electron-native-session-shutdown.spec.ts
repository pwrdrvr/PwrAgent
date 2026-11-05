import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Windows finishes session callbacks before will-quit after inspector detachment", async () => {
  test.skip(process.platform !== "win32", "Windows native storage shutdown");
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  let response: ServerResponse | undefined;
  let receivedRequest: () => void = () => undefined;
  const requestReceived = new Promise<void>((resolve) => { receivedRequest = resolve; });
  const server = createServer((_request, reply) => {
    response = reply;
    receivedRequest();
  });
  const prefix = `[e2e-session-quit:${randomUUID()}]`;
  let acceptedQuit: () => void = () => undefined;
  const quitAccepted = new Promise<void>((resolve) => { acceptedQuit = resolve; });
  const child = app.electronApp.process();
  let buffered = "";
  const onStderr = (chunk: Buffer | string) => {
    buffered += chunk.toString();
    if (buffered.includes(prefix)) acceptedQuit();
    buffered = buffered.slice(-prefix.length);
  };
  child.stderr?.on("data", onStderr);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected the loopback server address");
    await app.electronApp.evaluate(({ app, net, session }, { prefix, url }) => {
      let willQuit = false;
      app.once("will-quit", () => { willQuit = true; });
      app.on("before-quit", (event) => {
        // Production's listener runs first. Wait for its resource disposal
        // to finish and allow quit before releasing the controlled callback.
        if (!event.defaultPrevented) process.stderr.write(`${prefix}\n`);
      });
      const ownedSession = session.defaultSession;
      const clearData = ownedSession.clearData.bind(ownedSession);
      ownedSession.clearData = async (options) => {
        await (await net.fetch(url)).arrayBuffer();
        await clearData(options);
        if (willQuit) throw new Error("Entered will-quit before the owned session callback completed");
      };
    }, { prefix, url: `http://127.0.0.1:${address.port}/session-drain` });
    const closing = app.closeApplication();
    await Promise.race([
      Promise.all([requestReceived, quitAccepted]),
      closing.then(() => { throw new Error("Closed before the controlled session callback was released"); }),
    ]);
    response!.end("released");
    await closing;
  } finally {
    response?.end();
    try {
      await app.close();
    } finally {
      child.stderr?.removeListener("data", onStderr);
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }
});

test("Windows closes newly created persistent Chromium sessions", async () => {
  test.skip(process.platform !== "win32", "Windows native storage shutdown");
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const launcher = app.electronApp.process();
  let launcherClosed = false;
  launcher.once("close", () => { launcherClosed = true; });
  try {
    const initialized = await app.electronApp.evaluate(async ({ BrowserWindow, session }) => {
      const storagePaths: string[] = [];
      for (const partition of ["persist:e2e-shutdown-first", "persist:e2e-shutdown-second"]) {
        const ownedSession = session.fromPartition(partition);
        const window = new BrowserWindow({
          show: false,
          webPreferences: { session: ownedSession },
        });
        await window.loadURL("about:blank");
        storagePaths.push(ownedSession.getStoragePath()!);
      }
      return {
        storagePaths,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      };
    });
    await test.info().attach("native-runtime", {
      body: JSON.stringify({ electron: initialized.electron, chromium: initialized.chromium }),
      contentType: "application/json",
    });
    expect(new Set(initialized.storagePaths).size).toBe(2);
    for (const storagePath of initialized.storagePaths) {
      const relative = path.relative(app.homeRoot, storagePath);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.startsWith("..")).toBe(false);
    }
  } finally {
    await app.close();
  }
  expect(launcherClosed).toBe(true);
});
