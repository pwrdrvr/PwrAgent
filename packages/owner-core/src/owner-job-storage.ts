import type { AppServerThreadMessageOrigin } from "@pwragent/shared";

/** Durable acceptance/outcome metadata. Input and transcript text are provider-owned. */
export type OwnerJobRecord = {
  version: 1;
  id: string;
  status: "queued" | "starting" | "running" | "interrupting" | "completed" | "failed" | "interrupted" | "blocked" | "unknown";
  fingerprint?: string;
  delivery?: "queued-steer";
  threadId?: string | null;
  turnId?: string;
  model?: string | null;
  sandbox?: string;
  cwd?: string;
  messageOrigin?: AppServerThreadMessageOrigin;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  messagingFileTools?: boolean;
  createdAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  reason?: string;
};

export interface OwnerJobStorage {
  get(id: string): OwnerJobRecord | undefined;
  list(): OwnerJobRecord[];
  count(): number;
  save(job: OwnerJobRecord): OwnerJobRecord;
}
