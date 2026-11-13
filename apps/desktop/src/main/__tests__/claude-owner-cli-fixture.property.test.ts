// Contract test of the Claude CLI wire fixture that owner-conformance drives
// (`fixtures/claude-owner-cli.cjs`). A fixture turn holds until its test
// releases it, and the conformance test drains every turn it started before
// it closes the owner. A release the fixture can miss leaves that turn open
// for good: the conformance test then saw one `turn/completed` short, but
// only under full-suite load.
//
// The rule: a release completes its turn exactly once, wherever it lands
// relative to the prompt. The fixture used to wait for a `release-<n>` file
// through `fs.watch`, which on macOS arms after the call returns and drops
// a file written in that gap; this property hung on that fixture in 4 of 5
// runs. See helpers/claude-owner-cli-releases.ts.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openClaudeOwnerCliReleases } from "./helpers/claude-owner-cli-releases";

const FIXTURE = fileURLToPath(new URL("./fixtures/claude-owner-cli.cjs", import.meta.url));

it("completes every released turn exactly once, wherever the release lands", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "claude-owner-cli-"));
  copyFileSync(FIXTURE, path.join(workspace, "claude.js"));
  const releases = await openClaudeOwnerCliReleases(workspace);
  // One process serves every turn, as one Claude session does.
  const child = spawn(process.execPath, [path.join(workspace, "claude.js")], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown>> => {
    const { value, done } = await lines.next();
    if (done) throw new Error(`Fixture exited: ${stderr}`);
    return JSON.parse(value);
  };
  let index = 0;
  try {
    // beforePrompt: the conformance test's drain after a failed acceptance.
    // atInit: the tightest point after the provider reports the turn.
    // afterInit: a release that follows other test work.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("beforePrompt", "atInit", "afterInit"), { minLength: 1, maxLength: 8 }),
      async (timings) => {
        for (const timing of timings) {
          index += 1;
          const uuid = `prompt-${index}`;
          child.stdin.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: `Turn ${index}` } }) + "\n");
          if (timing === "beforePrompt") releases.release(index);
          expect(await next()).toMatchObject({ type: "system", subtype: "init" });
          if (timing === "atInit") releases.release(index);
          if (timing === "afterInit") await new Promise<void>((resolve) => setImmediate(resolve)).then(() => releases.release(index));
          expect(await next()).toMatchObject({ type: "assistant" });
          expect(await next()).toMatchObject({ type: "result", subtype: "success",
            result: `Claude fixture completed ${index}.`, user_message_uuids: [uuid] });
        }
      }), { numRuns: 20 });
  } finally {
    child.kill();
    await releases.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
