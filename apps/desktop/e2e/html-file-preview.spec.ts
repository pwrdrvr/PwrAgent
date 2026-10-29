import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureImagePath = path.resolve(specDir, "fixtures/thread-image-fit/thread-image.png");
const THREAD_TITLE = "HTML brief preview thread";

/** A loopback server that only counts what reaches it. The page must reach nothing. */
async function startProbeServer(): Promise<{ server: Server; origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "");
    response.writeHead(200, { "content-type": "image/png" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}`, hits };
}

/** A loopback UDP socket that counts STUN packets. WebRTC from the page must send none. */
async function startStunProbe(): Promise<{ socket: Socket; port: number; packets: () => number }> {
  let packets = 0;
  const socket = createSocket("udp4");
  socket.on("message", () => {
    packets += 1;
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return { socket, port: socket.address().port, packets: () => packets };
}

/**
 * Run in any window the page makes: report whether that window has WebRTC,
 * and if it does, send STUN to the probe.
 */
function rtcProbeScript(stunPort: number, tag: string, report: string): string {
  return `(function () {
  var Peer = window.RTCPeerConnection;
  ${report}.postMessage({ rtcProbe: ${JSON.stringify(tag)}, rtc: typeof Peer }, "*");
  if (!Peer) return;
  var peer = new Peer({ iceServers: [{ urls: "stun:127.0.0.1:${stunPort}" }] });
  peer.createDataChannel("probe");
  peer.createOffer().then(function (offer) { return peer.setLocalDescription(offer); });
})();`;
}

const inlineScript = (source: string) => `<script>${source}</script>`;
const htmlAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const jsString = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * Every way the page can get a window of its own: its own, a srcdoc child it
 * makes, a srcdoc grandchild, a srcdoc frame in its markup, and a frame
 * navigated to a `javascript:` URL. The last one must never report at all.
 */
function rtcProbePage(stunPort: number): string {
  const probe = (tag: string, report: string) => inlineScript(rtcProbeScript(stunPort, tag, report));
  const grandchild = `<iframe srcdoc="${htmlAttribute(probe("srcdoc grandchild", "parent.parent"))}"></iframe>`;
  return `<script>
window.rtcProbeReports = [];
addEventListener("message", function (event) {
  if (event.data && event.data.rtcProbe) {
    rtcProbeReports.push({ tag: event.data.rtcProbe, rtc: event.data.rtc });
  }
});
${rtcProbeScript(stunPort, "page", "window")}
var child = document.createElement("iframe");
child.srcdoc = ${jsString(probe("srcdoc child", "parent"))};
document.body.appendChild(child);
var nesting = document.createElement("iframe");
nesting.srcdoc = ${jsString(grandchild)};
document.body.appendChild(nesting);
var scripted = document.createElement("iframe");
scripted.src = "javascript:" + ${jsString(JSON.stringify(probe("javascript: child", "parent")))};
document.body.appendChild(scripted);
</script>
<iframe srcdoc="${htmlAttribute(probe("markup srcdoc", "parent"))}"></iframe>`;
}

async function createFixture(probeOrigin: string, stunPort: number): Promise<{
  cleanup: () => Promise<void>;
  fixturePath: string;
  homeRoot: string;
  briefPath: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-html-preview-"));
  const homeRoot = path.join(rootDir, "home");
  const siteDir = path.join(rootDir, "site");
  await mkdir(homeRoot, { recursive: true });
  await mkdir(siteDir, { recursive: true });
  await copyFile(fixtureImagePath, path.join(siteDir, "logo.png"));
  const briefPath = path.join(siteDir, "brief.html");
  await writeFile(briefPath, `<!doctype html>
<html><head><title>Brief</title>
<link rel="stylesheet" href="${probeOrigin}/style.css">
<link rel="preconnect" href="${probeOrigin}">
</head><body>
<h1 id="title">Product brief</h1>
<img id="local" src="logo.png" alt="Logo">
<img id="remote" src="${probeOrigin}/pixel.png" alt="Pixel">
<p><a id="web" href="https://example.com/docs">Docs</a></p>
<p><a id="next" href="appendix.html">Appendix</a></p>
<p><a id="jump" href="#end">Jump</a></p>
<div style="height: 2000px"></div>
<p id="end">End</p>
<script>document.body.setAttribute("data-ran", "yes");</script>
${rtcProbePage(stunPort)}
</body></html>`);
  await writeFile(path.join(siteDir, "appendix.html"), "<h1 id=\"appendix\">Appendix</h1>");

  const text = `The brief is ready: [brief.html](${briefPath}).`;
  const fixturePath = path.join(rootDir, "html-file-preview.fixture.json");
  await writeFile(fixturePath, JSON.stringify({
    metadata: { backend: "codex", scenario: "html-file-preview" },
    steps: [
      {
        id: "initialize-1",
        kind: "response",
        method: "initialize",
        result: {
          serverInfo: { name: "Replay Codex", version: "1.0.0" },
          methods: ["thread/list", "thread/read", "skills/list"],
        },
      },
      {
        id: "thread-list-1",
        kind: "response",
        method: "thread/list",
        result: [{
          id: "thread-html-preview",
          title: THREAD_TITLE,
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          updatedAt: 1_000,
        }],
      },
      {
        id: "thread-read-1",
        kind: "response",
        method: "thread/read",
        result: {
          entries: [{ type: "message", id: "html-message-1", role: "assistant", text }],
          messages: [{ id: "html-message-1", role: "assistant", text }],
          lastAssistantMessage: text,
          pagination: { supportsPagination: false, hasPreviousPage: false },
        },
      },
    ],
  }, null, 2));

  return {
    fixturePath,
    homeRoot,
    briefPath,
    cleanup: async () => {
      await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test("previews an HTML file offline, with scripts off until asked, and asks before following links", async () => {
  const probe = await startProbeServer();
  const stun = await startStunProbe();
  const controlStun = await startStunProbe();
  const fixture = await createFixture(probe.origin, stun.port);
  const app = await launchElectronApp({
    fixturePath: fixture.fixturePath,
    homeRoot: fixture.homeRoot,
  });

  try {
    await app.window.getByRole("button", { name: new RegExp(THREAD_TITLE, "i") }).first().click();
    await app.window.getByRole("link", { name: "brief.html" }).click();

    const dialog = app.window.getByRole("dialog", { name: "HTML document: brief.html" });
    await expect(dialog).toBeVisible();
    const frameElement = dialog.locator('iframe[title="HTML preview: brief.html"]');
    await expect(frameElement).toHaveAttribute("sandbox", "");
    const frame = dialog.frameLocator('iframe[title="HTML preview: brief.html"]');

    // The page renders, its image comes from beside it, and its script does not run.
    await expect(frame.locator("#title")).toHaveText("Product brief");
    await expect(frame.locator("#local")).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(frame.locator("#remote")).not.toHaveAttribute("src", /.+/);
    await expect(frame.locator("body")).not.toHaveAttribute("data-ran", "yes");
    // The header names the file once and carries the page's permissions.
    await expect(dialog.getByRole("heading", { name: "brief.html", exact: true })).toBeVisible();
    const scripts = dialog.getByRole("switch", { name: "Scripts", exact: true });
    await expect(scripts).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByText("2 blocked", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Blocked 2 web resources", { exact: true })).toHaveCount(1);

    // A web link is offered with its URL, never followed by the frame.
    await frame.locator("#web").click();
    await expect(dialog.getByText("Open this link in your browser?")).toBeVisible();
    await expect(dialog.getByText("https://example.com/docs")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(frame.locator("#title")).toHaveText("Product brief");

    // A fragment link stays in the page.
    await frame.locator("#jump").click();
    await expect(dialog.getByText("Open this link in your browser?")).toHaveCount(0);
    await expect(frame.locator("#title")).toHaveText("Product brief");

    // Scripts run on request, and still cannot reach the network.
    await scripts.click();
    await expect(scripts).toHaveAttribute("aria-checked", "true");
    await expect(frameElement).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.locator("body")).toHaveAttribute("data-ran", "yes");
    const reach = await frame.locator("body").evaluate(async (_body, origin) => {
      const fetched = await fetch(`${origin}/fetch`).then(() => true, () => false);
      const image = await new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = `${origin}/image.png`;
      });
      // A beacon reports only that it queued; the probe server's log is the proof.
      navigator.sendBeacon(`${origin}/beacon`, "x");
      const parentReadable = (() => {
        try {
          return Boolean(window.parent.document.body);
        } catch {
          return false;
        }
      })();
      const localImage = (document.getElementById("local") as HTMLImageElement).naturalWidth > 0;
      return {
        origin: location.origin,
        fetched,
        image,
        parentReadable,
        rtc: typeof (window as { RTCPeerConnection?: unknown }).RTCPeerConnection,
        localImage,
      };
    }, probe.origin);
    expect(reach).toEqual({
      origin: "null",
      fetched: false,
      image: false,
      parentReadable: false,
      rtc: "undefined",
      localImage: true,
    });

    // WebRTC is gone from every window the page made, nested ones included.
    // CSP cannot block it, and ICE would carry data out as STUN and DNS.
    await expect.poll(() => frame.locator("body").evaluate(
      () => (window as unknown as { rtcProbeReports: unknown[] }).rtcProbeReports.length,
    )).toBeGreaterThanOrEqual(4);
    // The app's own window keeps WebRTC (native voice uses it), and its STUN
    // reaches a probe like this one. The page's attempts started earlier, so
    // any of them would have landed by the time this one does.
    const controlRtc = await app.window.evaluate((port) => {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
      peer.createDataChannel("control");
      void peer.createOffer().then((offer) => peer.setLocalDescription(offer));
      return typeof RTCPeerConnection;
    }, controlStun.port);
    expect(controlRtc).toBe("function");
    await expect.poll(() => controlStun.packets()).toBeGreaterThan(0);
    const rtcReports = await frame.locator("body").evaluate(
      () => (window as unknown as { rtcProbeReports: { tag: string; rtc: string }[] }).rtcProbeReports,
    );
    expect([...rtcReports].sort((a, b) => a.tag.localeCompare(b.tag))).toEqual([
      { tag: "markup srcdoc", rtc: "undefined" },
      { tag: "page", rtc: "undefined" },
      { tag: "srcdoc child", rtc: "undefined" },
      { tag: "srcdoc grandchild", rtc: "undefined" },
    ]);
    expect(stun.packets()).toBe(0);

    // A link to another previewable file opens it in the viewer.
    await frame.locator("#next").click();
    await expect(dialog.getByText("Open appendix.html here?")).toBeVisible();
    await dialog.getByRole("button", { name: "Open", exact: true }).click();
    const appendix = app.window.getByRole("dialog", { name: "HTML document: appendix.html" });
    await expect(appendix).toBeVisible();
    await expect(
      appendix.frameLocator('iframe[title="HTML preview: appendix.html"]').locator("#appendix"),
    ).toHaveText("Appendix");

    expect(probe.hits).toEqual([]);
  } finally {
    await app.close();
    await fixture.cleanup();
    await new Promise<void>((resolve) => probe.server.close(() => resolve()));
    stun.socket.close();
    controlStun.socket.close();
  }
});
