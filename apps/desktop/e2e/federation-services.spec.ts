import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { startInProcessFederationGateway } from "./fixtures/federation-gateway";

test("remote thread services explicitly connect real HTTP and WS and release on disconnect", async ({ browserName: _browserName }, testInfo) => {
  const http = createServer((_request, response) => response.end("Invented preview data"));
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(`reload:${data}`)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const ownerPort = (http.address() as AddressInfo).port;
  const gateway = await startInProcessFederationGateway({
    instanceLabel: "Fixture development host",
    threads: [{ id: "service-fixture", title: "Preview development app", updatedAt: 2000 }],
    threadServices: [{ threadId: "service-fixture", args: { port: ownerPort, name: "Development preview", protocol: "http", description: "Invented HTTP and WebSocket fixture" } }],
  });
  let app: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  let browserSocket: WebSocket | undefined;
  try {
    app = await launchElectronApp({ fixturePath: path.join(process.cwd(), "e2e/fixtures/smoke/replay.fixture.json"), secretStorage: "memory" });
    const { window, electronApp } = app;
    await window.getByRole("button", { name: "Open settings" }).click();
    await window.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Federation", exact: true }).click();
    await window.getByLabel("Import invite").fill(gateway.invite);
    await window.getByRole("button", { name: "Import invite" }).click();
    await gateway.waitForConnection();
    await expect(window.getByRole("region", { name: "Connection" }).getByText("Connected", { exact: true })).toBeVisible();
    const opened = electronApp.waitForEvent("window");
    await window.getByRole("button", { name: "Browse remote threads" }).click();
    const remote = await opened;
    await remote.waitForLoadState("domcontentloaded");
    await remote.getByRole("button", { name: "Preview development app", exact: true }).click();
    const services = remote.getByRole("region", { name: "Thread services" });
    await services.getByRole("button", { name: "Services · 1" }).click();
    await expect(services.getByText("Development preview", { exact: true })).toBeVisible();
    await expect(services.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
    await remote.screenshot({ path: testInfo.outputPath("services-available.png") });
    await services.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(services.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    const mapping = await services.locator(".thread-services__identity").innerText();
    const localPort = Number(mapping.match(/127\.0\.0\.1:(\d+) →/)?.[1]);
    expect(localPort).toBeGreaterThan(0);
    expect(localPort).not.toBe(ownerPort);
    const url = `http://127.0.0.1:${localPort}/`;
    expect(await (await fetch(url)).text()).toBe("Invented preview data");
    browserSocket = new WebSocket(url.replace("http:", "ws:"));
    await once(browserSocket, "open");
    const message = once(browserSocket, "message");
    browserSocket.send("fixture-change");
    expect(String((await message)[0])).toBe("reload:fixture-change");
    await remote.screenshot({ path: testInfo.outputPath("services-connected.png") });
    const closed = once(browserSocket, "close");
    await services.getByRole("button", { name: "Disconnect", exact: true }).click();
    await closed;
    await expect(services.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await expect(fetch(url)).rejects.toThrow();
    await services.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(services.getByText("No services advertised for this thread.")).toBeVisible();
  } finally {
    browserSocket?.terminate();
    await app?.close();
    await gateway.close();
    for (const socket of ws.clients) socket.terminate();
    ws.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
