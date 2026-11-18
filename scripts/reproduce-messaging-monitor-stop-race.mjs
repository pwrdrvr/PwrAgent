import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Known-bad evidence, intentionally separate from the intended-behavior oracle.
// The original and move-only extraction revisions must both reproduce the
// assertion failure, even when the working tree contains the correctness fix.
const baseline = "e64dc010dbc05e5875affc8932eb8faa38c78af5";
const extraction = "d4e7a215b4edaeeb9847ab8d673693612dbee107";
const controller = "apps/desktop/src/main/messaging/core/messaging-controller.ts";
const workflow = "apps/desktop/src/main/messaging/core/messaging-monitor-workflow.ts";
const test = "apps/desktop/src/main/__tests__/messaging-monitor-known-race.test.ts";
const directory = ".local/pwr-149-monitor-workflow/known-race";
const original = process.argv.includes("--baseline");
const file = original ? controller : workflow;
const revision = original ? baseline : extraction;
const saved = readFileSync(file);
if (existsSync(test)) throw new Error("Refusing to replace an existing test");
const protectedPaths = ["turn-event-stream.json", "sqlite-write-budgets.json"].map(name => `apps/desktop/src/main/__tests__/fixtures/${name}`);
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const before = protectedPaths.map(hash);
const source = `import { expect, it } from "vitest";
import fc from "fast-check";
import { messagingMonitorHarness } from "./fixtures/messaging-monitor-harness";
it("preserves stop authority when an older render settles", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("telegram", "discord"), async (scheduler, channel) => {
    const f = await messagingMonitorHarness({ channel });
    const entered = Promise.withResolvers<void>(); let pending: Promise<void> | undefined;
    try {
      f.hooks.deliver = async intent => {
        if (intent.kind === "status") { entered.resolve(); await scheduler.schedule(Promise.resolve(), "old render"); }
      };
      pending = f.command();
      await Promise.race([entered.promise, pending.then(() => { expect.fail("Monitor must reach delivery"); })]);
      await f.command(["stop"]);
      expect((await f.subscription())?.monitor.enabled).toBe(false);
      await scheduler.waitFor(pending);
      expect((await f.subscription())?.monitor.enabled, "old render must preserve the stop").toBe(false);
      expect(f.timers.size).toBe(0);
    } finally { await scheduler.waitAll(); await pending; await f.close(); }
  }), { numRuns: 10 });
});
`;
mkdirSync(directory, { recursive: true });
const log = `${directory}/${original ? "original" : "extracted"}.log`;
try {
  writeFileSync(test, source);
  writeFileSync(file, execFileSync("git", ["show", `${revision}:${file}`]));
  const fd = openSync(log, "w");
  let result;
  try { result = spawnSync("pnpm", ["test", test], { stdio: ["ignore", fd, fd] }); }
  finally { closeSync(fd); }
  if (result.error) throw result.error;
  const output = readFileSync(log, "utf8");
  if (result.status === 0 || !/AssertionError: old render must preserve the stop/.test(output)
    || /(?:Caused by: )?(?:TypeError|ReferenceError):|Test timed out|Transform failed/.test(output)) throw new Error(`Invalid race proof: ${log}`);
  console.log(JSON.stringify({ revision, original, assertionFailureReproduced: true, log }));
} finally {
  writeFileSync(file, saved);
  rmSync(test, { force: true });
  if (protectedPaths.some((file, index) => hash(file) !== before[index])) throw new Error("Protected fixture changed");
}
