import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Windows retains session callbacks and the inspector until preparation completes", async () => {
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
  const stages: string[] = [];
  const child = app.electronApp.process();
  let buffered = "";
  const onStderr = (chunk: Buffer | string) => {
    buffered += chunk.toString();
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end);
      const start = line.indexOf(prefix);
      if (start >= 0) stages.push(line.slice(start + prefix.length).trim());
      buffered = buffered.slice(end + 1);
    }
    buffered = buffered.slice(-16_384);
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
      app.on("before-quit", () => process.stderr.write(`${prefix}before-quit\n`));
      app.once("will-quit", () => process.stderr.write(`${prefix}will-quit\n`));
      const ownedSession = session.defaultSession;
      const clearData = ownedSession.clearData.bind(ownedSession);
      ownedSession.clearData = async (options) => {
        await (await net.fetch(url)).arrayBuffer();
        await clearData(options);
        process.stderr.write(`${prefix}callback-complete\n`);
      };
    }, { prefix, url: `http://127.0.0.1:${address.port}/session-drain` });
    const closing = app.closeApplication();
    await Promise.race([
      requestReceived,
      closing.then(() => { throw new Error("Closed before the controlled session callback was released"); }),
    ]);
    // The inspector and renderer are owned until the controlled callback
    // completes. Waiting for quit here would make the test hold readiness
    // until shutdown, while shutdown correctly waits for readiness.
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
    expect(stages).toEqual([]);
    response!.end("released");
    await closing;
    expect(stages[0]).toBe("callback-complete");
    expect(stages).toContain("before-quit");
    expect(stages.at(-1)).toBe("will-quit");
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
