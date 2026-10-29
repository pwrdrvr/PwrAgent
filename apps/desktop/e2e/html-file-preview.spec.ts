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

async function createFixture(probeOrigin: string): Promise<{
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
  const fixture = await createFixture(probe.origin);
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
  }
});
