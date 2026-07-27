#!/usr/bin/env node

import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.resolve(
  desktopRoot,
  "..",
  "grok-app-server",
  "dist",
  "index.mjs",
);
const destinationDirectory = path.resolve(
  desktopRoot,
  "out",
  "grok-app-server",
);
const destination = path.join(destinationDirectory, "index.mjs");

await stat(source);
await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
console.log(`staged Grok app-server: ${destination}`);
