import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(desktop, "package.json"));
const root = await mkdtemp(join(tmpdir(), "pwragent-rendering-ownership-"));
try {
  await build({
    configFile: false, logLevel: "error", root: desktop,
    resolve: { alias: process.env.PWRAGENT_RENDERING_CAPTURE_SOURCE ? [{
      find: "../../../src/main/diagnostics/rendering-capture",
      replacement: resolve(process.env.PWRAGENT_RENDERING_CAPTURE_SOURCE),
    }] : [] },
    build: {
      ssr: join(desktop, "scripts/fixtures/rendering-ownership/main.ts"),
      outDir: join(root, "app"), emptyOutDir: true,
      rollupOptions: { external: ["electron"], output: { format: "es", entryFileNames: "main.mjs" } },
    },
  });
  for (const kind of ["cdp", "content"]) {
    const env = { ...process.env, PWRAGENT_RENDERING_FIXTURE_ROOT: root, PWRAGENT_RENDERING_EXTERNAL_KIND: kind };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [join(root, "app/main.mjs")], { env, stdio: "inherit" });
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    if (exit) { process.exitCode = exit; break; }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
