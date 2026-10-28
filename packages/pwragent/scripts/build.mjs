import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "dist"), { recursive: true });
const result = await build({
  entryPoints: [path.join(root, "src/federation-core.ts")],
  outfile: path.join(root, "dist/federation-core.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  metafile: true,
  banner: { js: 'import { createRequire as __pwragentCreateRequire } from "node:module"; const require = __pwragentCreateRequire(import.meta.url);' },
  external: ["bufferutil", "utf-8-validate"],
});
const require = createRequire(import.meta.url);
const federationPackage = require.resolve("@pwragent/federation/federation-transport");
const federationRequire = createRequire(federationPackage);
await copyFile(path.join(path.dirname(federationRequire.resolve("ws/package.json")), "LICENSE"), path.join(root, "dist/ws-LICENSE"));

const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (/apps\/desktop\/|messaging\/providers\/|node_modules\/electron\//.test(input)) {
    throw new Error(`Outpost bundle crossed its service boundary: ${input}`);
  }
  if (!input.includes("node_modules/")) continue;
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      if (metadata.name && metadata.version) {
        packages.set(`${metadata.name}@${metadata.version}`, { directory, metadata });
        break;
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    directory = path.dirname(directory);
  }
}
const notices = [];
for (const [name, { directory, metadata }] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
  const files = (await readdir(directory)).filter((file) => /^(?:licen[cs]e|notice)(?:[.-]|$)/i.test(file));
  if (!files.length && ["@xterm/headless@6.0.0", "@xterm/addon-serialize@0.14.0"].includes(name)) {
    notices.push(`${name} (${metadata.license})\n${"=".repeat(72)}\n`
      + await readFile(path.join(root, "licenses/xterm-LICENSE"), "utf8"));
    continue;
  }
  if (!files.length) throw new Error(`Bundled package has no license notice: ${name}`);
  notices.push(`${name} (${metadata.license})\n${"=".repeat(72)}\n`
    + (await Promise.all(files.map((file) => readFile(path.join(directory, file), "utf8")))).join("\n"));
}
await writeFile(path.join(root, "dist/THIRD_PARTY_LICENSES"), notices.join("\n\n"));
