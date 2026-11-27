import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { startOutpostDaemon } from "./helpers/outpost-daemon";

it.skipIf(process.platform === "win32")("requires a top-level Outpost readiness record before enrolling a viewer", async ({ signal, onTestFinished }) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pa-outpost-readiness-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "bin"));
  await writeFile(path.join(directory, "bin", "pwragent.js"), `
    if (process.argv[2] === "serve") {
      console.log('{"diagnostic":{"ready":true}}');
      process.exitCode = 17;
    } else {
      throw new Error("attempted enrollment before readiness");
    }
  `);
  await expect(startOutpostDaemon({ packageRoot: directory, signal })).rejects.toThrow("Outpost startup failed (17)");
});
