import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium, type Browser } from "@playwright/test";
import { build, normalizePath, preview, type Plugin } from "vite";
import { resolveConfig } from "electron-vite";

// Standalone Chromium probe: no Electron, profile, backend, or operator data.
// Run from the repository root:
// pnpm --filter @pwragent/desktop exec tsx scripts/verify-markdown-math-loading.ts
// Add --baseline-ref=<commit> to verify the old provider/consumer from Git.
const desktop = fileURLToPath(new URL("..", import.meta.url));
const baselineRef = process.argv.find((arg) => arg.startsWith("--baseline-ref="))?.slice("--baseline-ref=".length);
const output = resolve(desktop, "../../.local/math-loading", baselineRef ? "baseline" : "current");
const baselineSources = new Map<string, string>();
if (baselineRef) {
  for (const file of ["lib/markdown-rendering-options.tsx", "features/thread-detail/ThreadMarkdown.tsx"]) {
    const path = `apps/desktop/src/renderer/src/${file}`;
    baselineSources.set(normalizePath(resolve(desktop, "src/renderer/src", file)), execFileSync(
      "git", ["show", `${baselineRef}:${path}`], { cwd: desktop, encoding: "utf8" },
    ));
  }
}
await mkdir(output, { recursive: true });
const loaded = await resolveConfig({
  configFile: resolve(desktop, "electron.vite.config.ts"),
}, "build", "production");
const config = loaded.config?.renderer;
assert(config, "Missing renderer build configuration");
const mathModule = /(?:markdown-math(?:-runtime)?\.[tc]|node_modules\/(?:remark-math|rehype-katex|katex|micromark-extension-math|mdast-util-math)\/|markdown-math\.css)/;
const reports: unknown[] = [];
function boundaries(label: string): Plugin {
  return {
    name: "verify-math-boundaries",
    generateBundle(_options, bundle) {
      const eager = new Set<string>();
      function visit(name: string) {
        if (eager.has(name)) return;
        eager.add(name);
        const entry = bundle[name];
        if (entry?.type === "chunk") entry.imports.forEach(visit);
      }
      for (const entry of Object.values(bundle)) {
        if (entry.type === "chunk" && entry.isEntry) visit(entry.fileName);
      }
      const chunks = Object.values(bundle).filter((entry) => entry.type === "chunk").map((entry) => {
        const math = Object.keys(entry.modules).filter((id) => mathModule.test(id));
        const cssImports = [...((entry as typeof entry & {
          viteMetadata?: { importedCss: Set<string> };
        }).viteMetadata?.importedCss ?? [])];
        for (const file of cssImports) {
          const asset = bundle[file];
          assert(!(eager.has(entry.fileName) && asset?.type === "asset"
            && /KaTeX|\.katex/.test(String(asset.source))), `Eager math CSS: ${file}`);
        }
        assert(!(eager.has(entry.fileName) && math.length), `Eager math modules: ${math.join(", ")}`);
        return {
          file: entry.fileName, eager: eager.has(entry.fileName), bytes: Buffer.byteLength(entry.code),
          gzipBytes: gzipSync(entry.code).length, mathModules: math,
          imports: entry.imports, dynamicImports: entry.dynamicImports, cssImports,
        };
      });
      assert(chunks.some((chunk) => chunk.mathModules.length), "Math runtime missing from build");
      const css = Object.values(bundle).flatMap((entry) => entry.type === "asset" && entry.fileName.endsWith(".css")
        ? [{ file: entry.fileName, bytes: Buffer.byteLength(entry.source) }] : []);
      reports.push({ label, eagerJsBytes: chunks.filter((chunk) => chunk.eager).reduce((n, chunk) => n + chunk.bytes, 0), chunks, css });
    },
  };
}
for (const [label, root] of [
  ["production-renderer", resolve(desktop, "src/renderer")],
  ["browser-fixture", resolve(desktop, "scripts/fixtures/markdown-math-loading")],
]) {
  await build({ ...config, configFile: false, root, logLevel: "warn",
    plugins: [{ name: "baseline-math-sources", enforce: "pre",
      transform(_code, id) { return baselineSources.get(id); },
    }, ...(config.plugins ?? []), boundaries(label)],
    build: { ...config.build, outDir: resolve(output, label), emptyOutDir: true,
      rollupOptions: { ...config.build?.rollupOptions, input: resolve(root, "index.html") },
    },
  });
}
await writeFile(resolve(output, "bundle-boundaries.json"), JSON.stringify(reports, null, 2));
const server = await preview({ configFile: false, root: resolve(desktop, "scripts/fixtures/markdown-math-loading"),
  build: { outDir: resolve(output, "browser-fixture") }, preview: { host: "127.0.0.1", port: 0 },
});
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => errors.push(error.message));
  const mathRequests = () => requests.filter((url) => /markdown-math|katex/i.test(url));
  const url = server.resolvedUrls?.local[0];
  assert(url, "Preview server did not provide a URL");
  await page.goto(url);
  await page.getByRole("heading", { name: "Ordinary Markdown" }).first().waitFor();
  await page.waitForLoadState("networkidle");
  if (baselineRef) {
    assert.equal(mathRequests().filter((url) => /markdown-math-runtime.*\.js$/.test(url)).length, 1);
    assert.equal(mathRequests().filter((url) => /markdown-math-runtime.*\.css$/.test(url)).length, 1);
    assert.equal(await page.locator(".katex").count(), 0);
    const evidence = { baselineRef, ordinaryMathRequests: mathRequests(), renderedExpressions: 0, errors };
    assert.deepEqual(errors, []);
    await writeFile(resolve(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } else {
    assert.deepEqual(mathRequests(), [], "Ordinary enabled Markdown loaded math assets");
    const ordinary = { mathRequests: mathRequests(), katex: await page.locator(".katex").count() };
    const input = page.getByRole("textbox", { name: "Message" });
    await page.getByRole("checkbox").uncheck();
    await input.fill("$$x$$");
    await page.waitForLoadState("networkidle");
    assert.deepEqual(mathRequests(), [], "Disabled math loaded assets");
    await input.fill("stream $");
    await page.getByRole("checkbox").check();
    assert.deepEqual(mathRequests(), []);
    await input.fill("stream $$x$$");
    await page.locator(".katex").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const firstMathRequests = mathRequests();
    assert.equal(firstMathRequests.filter((url) => /markdown-math-runtime.*\.js$/.test(url)).length, 1);
    assert.equal(firstMathRequests.filter((url) => /markdown-math-runtime.*\.css$/.test(url)).length, 1);
    assert(firstMathRequests.some((url) => /KaTeX.*\.woff2$/.test(url)), "Expected math font request");
    assert.equal(await page.getByRole("region", { name: "Ordinary sibling" }).locator(".katex").count(), 0);
    await input.fill(String.raw`Inline \(a=1\).` + "\n\n\\[\nx^2\n\\]\n\n~~~math\ny=2\n~~~");
    await page.waitForFunction(() => document.querySelectorAll(".katex").length === 3);
    assert.equal(await page.locator(".katex-display").count(), 2);
    assert.equal(await page.locator(".katex-error").count(), 0);
    await page.getByRole("checkbox").uncheck();
    assert.equal(await page.locator(".katex").count(), 0);
    // A fresh document proves a code-only false positive can fetch without
    // typesetting. Detection is a loading hint, never a rendering decision.
    const runtimeRequestsBeforeReload = mathRequests().filter((url) => /markdown-math-runtime.*\.js$/.test(url)).length;
    await page.reload();
    await page.getByRole("textbox", { name: "Message" }).fill("`$$literal$$`");
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator(".katex").count(), 0);
    assert.equal(mathRequests().filter((url) => /markdown-math-runtime.*\.js$/.test(url)).length, runtimeRequestsBeforeReload + 1);
    assert.deepEqual(errors, []);
    const evidence = { ordinary, firstMathRequests, finalMathRequests: mathRequests(), errors };
    await writeFile(resolve(output, "browser-evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ordinary, firstMathAssetRequests: firstMathRequests.length, renderedExpressions: 3, errors }));
  }
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.httpServer.close((error) => error ? reject(error) : done()));
}
