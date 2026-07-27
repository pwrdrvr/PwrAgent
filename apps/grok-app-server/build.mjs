#!/usr/bin/env node

import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = resolve(packageRoot, "dist");
const outputPath = resolve(outputDirectory, "index.mjs");
const requestingFixtureOutputPath = resolve(
  outputDirectory,
  "requesting-entrypoint.mjs",
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await buildEntrypoint("src/index.ts", outputPath, true);
await buildEntrypoint(
  "src/testing/requesting-entrypoint.ts",
  requestingFixtureOutputPath,
  false,
);

async function buildEntrypoint(entry, outfile, minify) {
  await build({
    entryPoints: [resolve(packageRoot, entry)],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    minify,
    sourcemap: false,
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
    plugins: [rawTextPlugin()],
  });
  await chmod(outfile, 0o755);
}

function rawTextPlugin() {
  return {
    name: "raw-text",
    setup(buildContext) {
      buildContext.onResolve({ filter: /\?raw$/ }, (args) => ({
        path: pathWithoutRawSuffix(resolve(args.resolveDir, args.path)),
        namespace: "raw-text",
      }));
      buildContext.onLoad(
        { filter: /.*/, namespace: "raw-text" },
        async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }),
      );
    },
  };
}

function pathWithoutRawSuffix(value) {
  return value.endsWith("?raw") ? value.slice(0, -"?raw".length) : value;
}
