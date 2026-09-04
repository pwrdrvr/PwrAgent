import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScheduledThreadAction } from "@pwragent/shared";

export type ScheduledThreadActionPayload = Pick<
  ScheduledThreadAction,
  | "displayText"
  | "fileAttachments"
  | "imageAttachments"
  | "manualReleaseRequired"
  | "review"
  | "turn"
>;

export interface ScheduledThreadActionPayloadStore {
  delete(ref: string): void;
  read(ref: string): ScheduledThreadActionPayload;
  write(actionId: string, payload: ScheduledThreadActionPayload): string;
}

export class FileScheduledThreadActionPayloadStore
implements ScheduledThreadActionPayloadStore {
  constructor(private readonly directory: string) {}

  write(actionId: string, payload: ScheduledThreadActionPayload): string {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const actionKey = createHash("sha256").update(actionId).digest("hex");
    const ref = `${actionKey}-${randomUUID()}.json`;
    const temporaryPath = path.join(this.directory, `.${ref}.tmp`);
    const finalPath = path.join(this.directory, ref);
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(payload), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(temporaryPath, finalPath);
      return ref;
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }

  read(ref: string): ScheduledThreadActionPayload {
    return JSON.parse(
      fs.readFileSync(this.resolve(ref), "utf8"),
    ) as ScheduledThreadActionPayload;
  }

  delete(ref: string): void {
    try {
      fs.unlinkSync(this.resolve(ref));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private resolve(ref: string): string {
    if (!ref || path.basename(ref) !== ref || !ref.endsWith(".json")) {
      throw new Error("Invalid scheduled action payload reference.");
    }
    return path.join(this.directory, ref);
  }
}

export class MemoryScheduledThreadActionPayloadStore
implements ScheduledThreadActionPayloadStore {
  private readonly payloads = new Map<string, ScheduledThreadActionPayload>();

  write(actionId: string, payload: ScheduledThreadActionPayload): string {
    const ref = `${actionId}:${randomUUID()}`;
    this.payloads.set(ref, structuredClone(payload));
    return ref;
  }

  read(ref: string): ScheduledThreadActionPayload {
    const payload = this.payloads.get(ref);
    if (!payload) throw new Error("Scheduled action payload not found.");
    return structuredClone(payload);
  }

  delete(ref: string): void {
    this.payloads.delete(ref);
  }
}
