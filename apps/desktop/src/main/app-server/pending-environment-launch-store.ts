import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  MaterializeDirectoryLaunchpadRequest,
  NavigationLaunchpadDraft,
} from "@pwragent/shared";

export type PendingEnvironmentLaunch = {
  backend: AppServerBackendKind;
  threadId: string;
  request: MaterializeDirectoryLaunchpadRequest;
  launchpad: NavigationLaunchpadDraft;
  messageOrigin?: AppServerThreadMessageOrigin;
};

/** Unsent launch requests belong to PwrAgent, outside the metadata database. */
export class PendingEnvironmentLaunchStore {
  private readonly pending = new Map<string, PendingEnvironmentLaunch>();
  constructor(private readonly directory?: string) {}

  private key(ref: { backend: AppServerBackendKind; threadId: string }): string {
    return createHash("sha256").update(JSON.stringify([ref.backend, ref.threadId])).digest("hex");
  }

  put(launch: PendingEnvironmentLaunch): void {
    const key = this.key(launch);
    if (this.directory) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `${key}.json`);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(launch), { mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    this.pending.set(key, structuredClone(launch));
  }

  get(ref: { backend: AppServerBackendKind; threadId: string }): PendingEnvironmentLaunch | undefined {
    const key = this.key(ref);
    const cached = this.pending.get(key);
    if (cached) return structuredClone(cached);
    if (!this.directory) return undefined;
    let data: string;
    try { data = readFileSync(path.join(this.directory, `${key}.json`), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const launch = JSON.parse(data) as PendingEnvironmentLaunch;
    if (launch.backend !== ref.backend || launch.threadId !== ref.threadId) {
      throw new Error("Pending environment launch identity does not match the thread.");
    }
    return launch;
  }

  delete(ref: { backend: AppServerBackendKind; threadId: string }): void {
    const key = this.key(ref);
    if (this.directory) rmSync(path.join(this.directory, `${key}.json`), { force: true });
    this.pending.delete(key);
  }
}
