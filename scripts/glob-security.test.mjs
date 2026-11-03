import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const asar = createRequire(desktop.resolve("@electron/asar"));
const { glob, globStream } = asar("glob");
const { Minimatch } = asar("minimatch");
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("glob advisory regressions", () => {
  for (const stream of [false, true]) {
    it(`stops directory I/O after aborting an async ${stream ? "stream" : "walk"}`, async () => {
      const directory = fs.mkdtempSync(join(tmpdir(), "pwragent-glob-abort-"));
      directories.push(directory);
      for (let i = 0; i < 16; i++) {
        fs.mkdirSync(join(directory, `dir-${i}`, "nested"), { recursive: true });
        fs.writeFileSync(join(directory, `dir-${i}`, "nested", "file.txt"), "fixture");
      }
      const controller = new AbortController();
      const reason = new Error("fixture abort");
      let reads = 0;
      let pending = 0;
      const filesystem = {
        ...fs,
        readdir(path, options, callback) {
          reads++;
          pending++;
          if (reads === 1) {
            // Let stream consumers attach their error handler first.
            queueMicrotask(() => controller.abort(reason));
          }
          return fs.readdir(path, options, (...args) => {
            try {
              callback(...args);
            } finally {
              pending--;
            }
          });
        },
      };
      const options = { cwd: directory, fs: filesystem, signal: controller.signal };
      const walk = async () => {
        if (stream) {
          for await (const _entry of globStream("**/*", options)) {
            // Drain until cancellation rejects the stream.
          }
        } else {
          await glob("**/*", options);
        }
      };
      await expect(walk()).rejects.toBe(reason);
      // Drain already-started filesystem callbacks before measuring work.
      const deadline = Date.now() + 2_000;
      while (pending && Date.now() < deadline) {
        await delay(1);
      }
      expect(pending).toBe(0);
      expect(reads).toBe(1);
    });
  }

  it("bounds globstar parent-pattern amplification at optimization level 2", () => {
    const pattern = "a/**/../b/c/**/../d/e/**/../f/g/**/../h/i";
    const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 8 });
    expect(matcher.globParts.length).toBeLessThanOrEqual(8);
    expect(new Minimatch("a/**/../b/c", { optimizationLevel: 2 }).match("a/../b/c")).toBe(true);
  });
});
