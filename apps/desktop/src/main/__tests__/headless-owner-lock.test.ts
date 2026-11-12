import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  acquireHeadlessOwnerLock,
  HEADLESS_OWNER_LOCK_DATABASE,
  HEADLESS_OWNER_LOCK_MARKER,
} from "../headless/owner-lock";

const MODULE_URL = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../headless/owner-lock.ts")).href;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function directory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "headless-owner-lock-"));
  roots.push(root);
  return root;
}

/** A separate owner process that holds the lock until it is killed. */
function holder(lockDirectory: string, instanceId: string): Promise<{ child: ChildProcessWithoutNullStreams; previous: string[] }> {
  const script = `
    const { acquireHeadlessOwnerLock } = await import(${JSON.stringify(MODULE_URL)});
    const lock = acquireHeadlessOwnerLock(${JSON.stringify(lockDirectory)});
    lock.record(${JSON.stringify(instanceId)});
    process.stdout.write(JSON.stringify(lock.previousInstanceIds) + "\\n");
    setInterval(() => {}, 60_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], { stdio: "pipe" });
  children.push(child);
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    child.once("exit", (code) => reject(new Error(`holder exited ${code}: ${stderr}`)));
    child.stdout.once("data", (bytes: Buffer) => resolve({ child, previous: JSON.parse(bytes.toString()) as string[] }));
  });
}

function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
}

it("refuses while another process holds the lock and takes over the moment that process is killed", async () => {
  const lockDirectory = directory();
  const first = await holder(lockDirectory, "runtime-v2-first");
  expect(first.previous).toEqual([]);
  expect(() => acquireHeadlessOwnerLock(lockDirectory)).toThrow(/Another headless owner is running/);

  // SIGKILL runs no cleanup: owner.lock stays, as it does when a container dies.
  await kill(first.child);
  expect(existsSync(path.join(lockDirectory, HEADLESS_OWNER_LOCK_MARKER))).toBe(true);

  const second = await holder(lockDirectory, "runtime-v2-second");
  expect(second.previous).toEqual(["runtime-v2-first"]);
  expect(() => acquireHeadlessOwnerLock(lockDirectory)).toThrow(/Another headless owner is running/);
  await kill(second.child);

  const third = acquireHeadlessOwnerLock(lockDirectory);
  expect(third.previousInstanceIds).toEqual(["runtime-v2-second", "runtime-v2-first"]);
  third.release();
}, 30_000);

it("keeps owner.lock private while held and removes it on a clean release", () => {
  const lockDirectory = directory();
  const lock = acquireHeadlessOwnerLock(lockDirectory, { processId: 1 });
  const marker = path.join(lockDirectory, HEADLESS_OWNER_LOCK_MARKER);
  // Windows has no POSIX modes; the Outpost runs on Linux and macOS only.
  if (process.platform !== "win32") {
    expect(statSync(marker).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(lockDirectory, HEADLESS_OWNER_LOCK_DATABASE)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ pid: 1 });
  lock.record("runtime-v2-clean");
  lock.release();
  expect(existsSync(marker)).toBe(false);
  const next = acquireHeadlessOwnerLock(lockDirectory);
  expect(next.previousInstanceIds).toEqual(["runtime-v2-clean"]);
  next.release();
});

it("never takes over an owner.lock written by an older PwrAgent, which may still be running", () => {
  const lockDirectory = directory();
  writeFileSync(path.join(lockDirectory, HEADLESS_OWNER_LOCK_MARKER), `${JSON.stringify({ pid: 1 })}\n`, { mode: 0o600 });
  expect(() => acquireHeadlessOwnerLock(lockDirectory)).toThrow(/Headless owner lock already exists.*older PwrAgent/);
  // The refusal released the lock; it does not strand the next attempt.
  rmSync(path.join(lockDirectory, HEADLESS_OWNER_LOCK_MARKER));
  acquireHeadlessOwnerLock(lockDirectory).release();
});

it("forgets an owner that never recorded itself rather than recording a partial start", () => {
  const lockDirectory = directory();
  acquireHeadlessOwnerLock(lockDirectory).release();
  const next = acquireHeadlessOwnerLock(lockDirectory);
  expect(next.previousInstanceIds).toEqual([]);
  next.release();
});
