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

  // Oracle: exported HTML must lay out every visible equation label inside
  // its own bounds without the application's CSS. Check PNG against the same
  // complete, tight layout rather than just accepting a decodable image.
  const equations = [
    String.raw`\begin{equation}p=q\end{equation}`,
    String.raw`\begin{equation}a=b\end{equation}`,
    String.raw`\begin{align}a&=b\\c&=d\notag\\e&=f\end{align}`,
    String.raw`a=b\tag{7}`,
    String.raw`\begin{align}a&=b\tag{A}\\c&=d\tag{B}\end{align}`,
    String.raw`a=b\tag*{custom}`,
    String.raw`a=b\tag{$\dfrac{1}{2}$}`,
  ];
  const equationUrl = new URL(server.resolvedUrls!.local[0]);
  equationUrl.searchParams.set("source", equations.map((tex) => `\\[\n${tex}\n\\]`).join("\n\n"));
  await page.goto(equationUrl.href);
  await page.locator(".katex").nth(equations.length - 1).waitFor();
  await page.evaluate(() => document.fonts.ready);
  const failures: string[] = [];
  for (let index = 1; index < equations.length; index++) {
    const formula = page.locator(".math-formula--display").nth(index);
    await page.evaluate(() => { window.formulaClipboard = {}; });
    await formula.hover();
    await formula.getByRole("button", { name: "Copy formula" }).click();
    await page.getByRole("menuitem", { name: "Copy formatted HTML" }).click();
    await page.waitForFunction(() => Boolean(window.formulaClipboard.html));
    const exported = await page.evaluate(() => window.formulaClipboard.html!);
    const isolated = await browser.newPage();
    try {
      await isolated.setContent(exported);
      await isolated.evaluate(() => document.fonts.ready);
      const layout = await isolated.locator(".katex").evaluate((root) => {
        const rect = root.getBoundingClientRect();
        return {
          width: rect.width, height: rect.height,
          labels: root.querySelector(".katex-html > .katex-tag")?.textContent?.match(/\(\d+\)/g) ?? [],
          mathmlLabels: root.querySelector(".katex-mathml")?.textContent?.match(/\(\d+\)/g) ?? [],
          tags: Array.from(root.querySelectorAll<HTMLElement>(".katex-html > .katex-tag")).map((tag) => {
            const bounds = tag.getBoundingClientRect();
            return { left: bounds.left - rect.left, right: bounds.right - rect.left,
              top: bounds.top - rect.top, bottom: bounds.bottom - rect.top };
          }),
        };
      });
      try {
        if (index === 1) assert.deepEqual(layout.labels, ["(2)"], "Generated number must preserve the page counter");
        if (index === 2) assert.deepEqual(layout.labels, ["(3)", "(4)"], "Unnumbered rows must not increment the counter");
        if (index < 3) assert.deepEqual(layout.mathmlLabels, layout.labels, "Accessible MathML must keep the same generated numbers");
        for (const tag of layout.tags) {
          assert(tag.left >= -0.5 && tag.right <= layout.width + 0.5
            && tag.top >= -0.5 && tag.bottom <= layout.height + 0.5,
          `Export must contain the entire tag: ${JSON.stringify({ tag, layout })}`);
        }
      } catch (error) { failures.push(String(error)); }
      await page.evaluate(() => { window.formulaClipboard = {}; });
      await formula.hover();
      await formula.getByRole("button", { name: "Copy formula" }).click();
      await page.getByRole("menuitem", { name: "Copy transparent PNG" }).click();
      await page.waitForFunction(() => Boolean(window.formulaClipboard.png));
      const imagePixels = await page.evaluate(async (tags) => {
        const image = new Image();
        image.src = window.formulaClipboard.png!;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, image.width, image.height).data;
        let borderInk = 0;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
          if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
            if (rgba[(y * image.width + x) * 4 + 3]) borderInk++;
          }
        }
        const tagInk = tags.map((tag) => {
          let ink = 0;
          for (let y = Math.max(0, Math.floor((tag.top + 4) * 2)); y < Math.min(image.height, Math.ceil((tag.bottom + 4) * 2)); y++) {
            for (let x = Math.max(0, Math.floor((tag.left + 4) * 2)); x < Math.min(image.width, Math.ceil((tag.right + 4) * 2)); x++) {
              if (rgba[(y * image.width + x) * 4 + 3]) ink++;
            }
          }
          return ink;
        });
        return { width: image.width, height: image.height, borderInk, tagInk };
      }, layout.tags);
      try {
        assert.equal(imagePixels.width, (Math.ceil(layout.width) + 8) * 2, "PNG must include the complete HTML layout");
        assert.equal(imagePixels.borderInk, 0, "PNG ink must not reach the crop boundary");
        assert(imagePixels.tagInk.every((ink) => ink > 30), "Every equation tag must appear in the PNG");
      } catch (error) { failures.push(String(error)); }
      if (index === 1 || index === 3) {
        await writeFile(resolve(output, `tag-${index}.png`), Buffer.from((await page.evaluate(() => window.formulaClipboard.png!)).split(",")[1], "base64"));
      }
    } finally { await isolated.close(); }
  }
  assert.deepEqual(failures, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ equationExportsChecked: equations.length - 1, failures }));
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
}
