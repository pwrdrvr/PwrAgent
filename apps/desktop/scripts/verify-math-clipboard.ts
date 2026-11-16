import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";
import { resolveConfig } from "electron-vite";
import type {} from "./fixtures/math-clipboard/types";

// A real production renderer with contrived content. Clipboard writes are
// intercepted inside this document, never sent to the operator's clipboard.
const desktop = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(desktop, "../../.local/formula-clipboard");
const root = resolve(desktop, "scripts/fixtures/math-clipboard");
await mkdir(output, { recursive: true });
const loaded = await resolveConfig({ configFile: resolve(desktop, "electron.vite.config.ts") }, "build", "production");
const config = loaded.config?.renderer;
assert(config);
const outDir = resolve(output, "fixture");
await build({ ...config, configFile: false, root, logLevel: "warn",
  build: { ...config.build, outDir, emptyOutDir: true,
    rolldownOptions: { ...config.build?.rolldownOptions, input: resolve(root, "index.html") },
  },
});
const server = await preview({ configFile: false, root, build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 620 }, deviceScaleFactor: 2 });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") console.log(message.text()); });
  page.on("request", (request) => requests.push(request.url()));
  // Literal JS avoids tsx's keepNames helpers leaking into the page context.
  await page.addInitScript(`(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      write: async (items) => {
        const png = await items[0].getType("image/png");
        const data = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsDataURL(png);
        });
        window.formulaClipboard = { png: data };
      },
    } });
  })()`);
  await page.goto(server.resolvedUrls!.local[0]);
  await page.getByRole("button", { name: "Copy formula" }).last().waitFor({ state: "attached" });
  assert.equal(await page.locator(".katex").count(), 2);
  const block = page.locator(".math-formula--display");
  const latex = await block.locator("annotation[encoding='application/x-tex']").textContent();
  assert(latex);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(output, "before.png") });
  const choose = async (name: string, inline = false) => {
    const formula = inline ? page.locator(".math-formula:not(.math-formula--display)") : block;
    await formula.hover();
    await formula.getByRole("button", { name: "Copy formula" }).click();
    await page.getByRole("menuitem", { name }).click();
  };
  await choose("Copy LaTeX");
  await page.waitForFunction((tex) => window.formulaClipboard.text === tex, latex);
  assert(!requests.some((url) => /math-clipboard-export/.test(url)), "LaTeX copy loaded the image exporter");
  await choose("Copy formatted HTML");
  await page.waitForFunction(() => Boolean(window.formulaClipboard.html) || Boolean(document.querySelector('[role="alert"]')));
  const html = await page.evaluate(() => window.formulaClipboard.html);
  assert(html, await page.locator("body").innerText());
  assert(html.includes("@font-face") && html.includes("base64,"), "HTML must carry its fonts");
  assert(html.includes("Khan Academy") && html.includes("Permission is hereby granted"), "Embedded fonts must retain their license notice");
  assert.equal(await page.evaluate(() => window.formulaClipboard.text), latex);

  async function copyPng(inline = false) {
    await page.evaluate(() => { window.formulaClipboard = {}; });
    await choose("Copy transparent PNG", inline);
    await page.waitForFunction(() => Boolean(window.formulaClipboard.png) || Boolean(document.querySelector('[role="alert"]')));
    const png = await page.evaluate(() => window.formulaClipboard.png);
    assert(png, await page.locator("body").innerText());
    return png;
  }
  const png = await copyPng();
  await writeFile(resolve(output, "formula.png"), Buffer.from(png.split(",")[1], "base64"));
  await page.evaluate((source) => {
    const preview = document.createElement("img");
    preview.id = "formula-export-preview";
    preview.src = source;
    preview.style.cssText = "display:block;background:white;padding:8px;max-width:none";
    document.body.append(preview);
  }, png);
  await page.locator("#formula-export-preview").screenshot({ path: resolve(output, "formula-on-white.png") });
  await page.locator("#formula-export-preview").evaluate((element) => element.remove());
  const pixels = await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    let transparent = 0;
    let ink = 0;
    let borderInk = 0;
    let minX = image.width;
    let maxX = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const offset = (y * image.width + x) * 4;
      if (rgba[offset + 3] === 0) transparent++;
      else {
        ink++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) borderInk++;
        if (rgba[offset] || rgba[offset + 1] || rgba[offset + 2]) throw new Error("Expected dark export ink");
      }
    }
    return { width: image.width, height: image.height, transparent, ink, borderInk, minX, maxX };
  }, png);
  assert(pixels.ink > 100 && pixels.transparent > pixels.ink && pixels.borderInk === 0, JSON.stringify(pixels));
  assert(pixels.minX < 24 && pixels.width - pixels.maxX < 24, "Export must crop the display container's empty margins");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  assert.equal(await copyPng(), png, "PNG appearance must not depend on the app theme");
  await block.locator(".katex-html").evaluate((element) => { (element as HTMLElement).style.color = "white"; });
  const colored = await copyPng();
  assert(await page.evaluate(async (source) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height).data;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] > 0 && pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255) return true;
    }
    return false;
  }, colored), "Explicit formula colors must survive theme normalization");
  await block.locator(".katex-html").evaluate((element) => { (element as HTMLElement).style.removeProperty("color"); });
  assert.notEqual(await copyPng(true), png, "Inline copy must export its own formula");
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.waitForFunction(() => document.querySelectorAll('.math-formula__copy[data-status="copied"]').length === 0);
  await block.hover();
  await block.getByRole("button", { name: "Copy formula" }).click();
  await page.screenshot({ path: resolve(output, "after.png") });
  assert.deepEqual(errors, []);
  const evidence = { latex, pngBytes: Buffer.from(png.split(",")[1], "base64").length, ...pixels, errors };
  await writeFile(resolve(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
