import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "dist"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src/federation-core.ts")],
  outfile: path.join(root, "dist/federation-core.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  external: ["bufferutil", "utf-8-validate"],
});
const require = createRequire(import.meta.url);
const federationPackage = require.resolve("@pwragent/federation/federation-transport");
const federationRequire = createRequire(federationPackage);
await copyFile(path.join(path.dirname(federationRequire.resolve("ws/package.json")), "LICENSE"), path.join(root, "dist/ws-LICENSE"));
