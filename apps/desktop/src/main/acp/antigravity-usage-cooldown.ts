import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { lock } from "proper-lockfile";
import { managedAntigravityRoot } from "./antigravity-runtime-retention.js";

const COOLDOWN_MS = 15 * 60_000;
// Cover the bounded CLI preflight, usage command and termination if the owner
// exits before it can record completion.
const UNCLEAN_EXIT_GRACE_MS = 60_000;

/** All profiles sharing a PwrAgent root share the CLI attempt budget. */
export async function withAntigravityUsageCooldown<T>(
  read: () => Promise<T>,
  root = managedAntigravityRoot(),
  now = Date.now,
): Promise<T | undefined> {
  const receipt = path.join(root, "usage-next-at");
  const isDue = async (): Promise<boolean> => {
    const text = await readFile(receipt, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text === undefined) return true;
    const next = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(next)) {
      throw new Error("Invalid Antigravity usage cooldown");
    }
    return now() >= next;
  };
  if (!await isDue()) return undefined;
  await mkdir(root, { recursive: true, mode: 0o700 });
  // A busy owner handles this gesture. Never queue a read behind it.
  let compromised: Error | undefined;
  const unlock = await lock(path.join(await realpath(root), "usage-next-at"), {
    realpath: false,
    stale: UNCLEAN_EXIT_GRACE_MS,
    onCompromised: (error) => { compromised = error; },
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOCKED") return undefined;
    throw error;
  });
  if (!unlock) return undefined;
  const record = async (next: number): Promise<void> => {
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, String(next), { flag: "wx", mode: 0o600 });
      if (compromised) throw compromised;
      await rename(temporary, receipt);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  try {
    if (!await isDue()) return undefined;
    await record(now() + COOLDOWN_MS + UNCLEAN_EXIT_GRACE_MS);
    try {
      return await read();
    } finally {
      await record(now() + COOLDOWN_MS);
    }
  } finally {
    if (!compromised) await unlock();
  }
}
