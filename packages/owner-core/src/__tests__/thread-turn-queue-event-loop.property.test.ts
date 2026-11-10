import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";

let directory: string;
let moduleUrl: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "pwragent-queue-event-loop-"));
  const outfile = join(directory, "queue.mjs");
  buildSync({
    entryPoints: [fileURLToPath(new URL("../thread-turn-queue.ts", import.meta.url))],
    outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });
  moduleUrl = pathToFileURL(outfile).href;
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function drainInIdleProcess(ids: string[], cancel = false): string[] {
  const script = `
    import { ThreadTurnQueue } from ${JSON.stringify(moduleUrl)};
    const ids = JSON.parse(process.argv[1]);
    const identity = { backend: "codex", threadId: "event-loop-oracle" };
    let active = true;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async (entry) => ({ ...identity, turnId: entry.id }),
      onLifecycle: async (event) => {
        if (event.type === "started") {
          process.stdout.write(JSON.stringify(event.entry.id) + "\\n");
          queue.close();
        }
      },
    });
    for (const id of ids) await queue.submit({ ...identity, id, origin: "manual", input: [] });
    let released = false;
    process.on("beforeExit", () => {
      if (released) return;
      released = true;
      active = false;
      queue.scheduleThreadDrain(identity);
      if (${cancel}) queue.close();
    });
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(ids)], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim() ? output.trim().split("\n").map((line) => JSON.parse(line) as string) : [];
}

// Native Node owns this oracle: no Vitest timers, polling or GUI activity may
// be needed to start an admitted head when its external occupancy ends.
it("property: pending dispatch owns the event loop until the head starts", () => {
  fc.assert(fc.property(fc.uniqueArray(fc.uuid(), { minLength: 1, maxLength: 5 }), (ids) => {
    expect(drainInIdleProcess(ids)).toEqual([ids[0]]);
  }), { numRuns: 12 });
});

it("starts one queued send without another timer or I/O event", () => {
  expect(drainInIdleProcess(["waiting-send"])).toEqual(["waiting-send"]);
});

it("closing the queue cancels dispatch without retaining the process", () => {
  expect(drainInIdleProcess(["cancelled"], true)).toEqual([]);
});
