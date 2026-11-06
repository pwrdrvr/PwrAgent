import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { closeElectronWithSessionDrain, launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("flushes the final cookie written by renderer unload before native quit", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const server = createServer((_request, reply) => {
    reply.setHeader("Content-Type", "text/html");
    reply.setHeader("Permissions-Policy", "unload=(self)");
    reply.end('<script>addEventListener("unload", () => { document.cookie = "renderer_final_write=present; path=/"; });</script>');
  });
  const prefix = `[e2e-final-cookie:${randomUUID()}]`;
  const launcher = app.electronApp.process();
  let output = "";
  const onStderr = (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-16_384); };
  launcher.stderr?.on("data", onStderr);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected the loopback server address");
    await app.electronApp.evaluate(async ({ BrowserWindow, session }, { prefix, url }) => {
      const window = new BrowserWindow({ show: false });
      await window.loadURL(url);
      const ownedSession = session.defaultSession;
      if ((await ownedSession.cookies.get({ name: "renderer_final_write" })).length) {
        throw new Error("The fixture cookie must not exist before renderer unload");
      }
      const flushStore = ownedSession.cookies.flushStore.bind(ownedSession.cookies);
      ownedSession.cookies.flushStore = async () => {
        await flushStore();
        const cookies = await ownedSession.cookies.get({ name: "renderer_final_write" });
        process.stderr.write(`${prefix}${JSON.stringify(cookies.map((cookie) => cookie.value))}\n`);
      };
    }, { prefix, url: `http://127.0.0.1:${address.port}/final-write` });
    await (process.platform === "win32"
      ? app.closeApplication()
      : closeElectronWithSessionDrain(app.electronApp));
    expect(output).toContain(`${prefix}["present"]`);
  } finally {
    try {
      await app.close();
    } finally {
      launcher.stderr?.removeListener("data", onStderr);
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  }
});

test("retains native session callbacks after renderers and inspector close", async () => {
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
    await app.electronApp.evaluate(({ app, BrowserWindow, net, session }, { prefix, url }) => {
      app.on("before-quit", () => process.stderr.write(`${prefix}before-quit\n`));
      app.on("will-quit", () => process.stderr.write(`${prefix}will-quit\n`));
      const ownedSession = session.defaultSession;
      const clearData = ownedSession.clearData.bind(ownedSession);
      ownedSession.clearData = async (options) => {
        process.stderr.write(`${prefix}remaining-renderers:${BrowserWindow.getAllWindows().length}\n`);
        await (await net.fetch(url)).arrayBuffer();
        await clearData(options);
        process.stderr.write(`${prefix}callback-complete\n`);
      };
    }, { prefix, url: `http://127.0.0.1:${address.port}/session-drain` });
    const closing = process.platform === "win32"
      ? app.closeApplication()
      : closeElectronWithSessionDrain(app.electronApp);
    await Promise.race([
      requestReceived,
      closing.then(() => { throw new Error("Closed before the controlled session callback was released"); }),
    ]);
    // Session ownership outlives both renderers and Playwright's inspector.
    // Native shutdown must remain held while this callback awaits real I/O.
    expect(stages).toContain("remaining-renderers:0");
    expect(stages).not.toContain("will-quit");
    expect(child.exitCode).toBeNull();
    response!.end("released");
    await closing;
    expect(stages.indexOf("callback-complete")).toBeLessThan(stages.indexOf("will-quit"));
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
