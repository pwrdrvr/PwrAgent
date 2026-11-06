// Claude session reader probe.
//
//   pnpm --filter @pwragent/desktop build
//   pnpm --filter @pwragent/desktop probe:claude-session-reader
//
// Checks what the unit tests of src/main/claude/claude-session-reader.ts
// cannot: that the built utility-process entry, started by Electron with a
// Claude config directory this process does not have, reads that
// directory's sessions through the Agent SDK. Re-run it after an Agent SDK
// or Electron upgrade. It exits non-zero on any mismatch.
//
// The probe writes its own two-message session into temporary config
// directories, the account the reader must see and the one this process
// sees. It shows no window and takes no focus.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

const worker = fileURLToPath(new URL("../out/main/claude-session-reader-worker.js", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pwragent-claude-reader-probe-"));
const SESSION = "5a85c1ad-85c1-4930-ae19-50f721ad13dd";
const PROJECT = "/tmp/pwragent-claude-reader-probe";
app.setPath("userData", join(root, "user-data"));

void app.whenReady().then(async () => {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  let code = 1;
  try {
    code = await probe();
  } catch (error) {
    console.error(`probe failed: ${error instanceof Error ? error.stack : String(error)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  app.exit(code);
});

async function probe() {
  if (!existsSync(worker)) {
    console.error(`${worker} is missing. Run pnpm --filter @pwragent/desktop build first.`);
    return 2;
  }
  const account = join(root, "account");
  const own = join(root, "own");
  writeSession(account, "Account prompt");
  mkdirSync(own, { recursive: true });
  // This process reads another directory, as PwrAgent launched from the Dock does.
  process.env.CLAUDE_CONFIG_DIR = own;
  const child = utilityProcess.fork(worker, [], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: account },
    stdio: "ignore",
    serviceName: "PwrAgent Claude session reader probe",
  });
  const replies = new Map();
  child.on("message", (reply) => replies.get(reply.id)?.(reply));
  const read = (id, method, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} did not answer`)), 15_000);
    replies.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    child.postMessage({ id, method, sessionId: SESSION, ...(options ? { options } : {}) });
  });
  try {
    const results = {
      inProject: await read(1, "getSessionMessages", { dir: PROJECT }),
      everyProject: await read(2, "getSessionMessages"),
      info: await read(3, "getSessionInfo"),
    };
    const checks = [
      ["messages in the project folder", results.inProject.result?.map((message) => message.uuid)],
      ["messages in any project folder", results.everyProject.result?.map((message) => message.uuid)],
    ];
    let failed = 0;
    for (const [name, uuids] of checks) {
      const ok = JSON.stringify(uuids) === JSON.stringify(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
      console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(uuids ?? results)}`);
      if (!ok) failed += 1;
    }
    const infoOk = results.info.result?.sessionId === SESSION;
    console.log(`${infoOk ? "ok  " : "FAIL"} session info: ${JSON.stringify(results.info.result ?? results.info)}`);
    if (!infoOk) failed += 1;
    console.log(failed === 0 ? "the reader read the launch environment's sessions" : `${failed} check(s) failed`);
    return failed === 0 ? 0 : 1;
  } finally {
    child.kill();
  }
}

function writeSession(configDir, prompt) {
  const folder = join(configDir, "projects", PROJECT.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  const base = { sessionId: SESSION, cwd: PROJECT, version: "2.1.0", isSidechain: false, userType: "external" };
  const lines = [
    {
      ...base, type: "user", uuid: "11111111-1111-4111-8111-111111111111", parentUuid: null,
      timestamp: "2026-11-05T00:00:00.000Z", message: { role: "user", content: prompt },
    },
    {
      ...base, type: "assistant", uuid: "22222222-2222-4222-8222-222222222222", parentUuid: "11111111-1111-4111-8111-111111111111",
      timestamp: "2026-11-05T00:00:01.000Z",
      message: { id: "msg_probe", role: "assistant", type: "message", model: "claude-probe", content: [{ type: "text", text: "Answer" }] },
    },
  ];
  writeFileSync(join(folder, `${SESSION}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}
