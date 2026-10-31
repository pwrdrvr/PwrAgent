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
    build: {
      ssr: join(desktop, "scripts/fixtures/rendering-ownership/main.ts"),
      outDir: join(root, "app"), emptyOutDir: true,
      rollupOptions: { external: ["electron"], output: { format: "es", entryFileNames: "main.mjs" } },
    },
  });
  const env = { ...process.env, PWRAGENT_RENDERING_FIXTURE_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [join(root, "app/main.mjs")], { env, stdio: "inherit" });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exit;
} finally {
  await rm(root, { recursive: true, force: true });
}
