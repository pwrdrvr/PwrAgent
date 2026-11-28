import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { factoryWorkItemKey, parseFactoryWorkItem, type FactoryWorkItem } from "@pwragent/shared/factory-work-item";
import { isGitObjectId } from "@pwragent/shared/git-object-id";
import { resolveActiveProfilePath } from "../profile";
import type { FactoryCleanCandidate } from "./factory-branch-evidence";

const MAX_RECEIPT_BYTES = 32 * 1024;
const label = (max: number) => z.string().trim().min(1).max(max).refine((value) => Array.from(value).every((character) => {
  const code = character.charCodeAt(0);
  return code >= 32 && code !== 127;
}));
const proof = label(512).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "file:" && !url.host));
}, "Expected an HTTPS or local file proof URL.");
const measure = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const metric = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,47}$/);
const boundedRecord = <T extends z.ZodType>(value: T) => z.record(metric, value).refine((entries) => {
  const count = Object.keys(entries).length;
  return count >= 1 && count <= 8;
});
const sample = z.strictObject({
  sizes: boundedRecord(z.int().min(0)),
  counters: boundedRecord(z.strictObject({ measured: measure, bound: measure })),
});
const workload = z.strictObject({
  name: label(160), proof, samples: z.array(sample).min(2).max(6),
}).refine(({ samples }) => {
  const first = samples[0];
  if (!first) return false;
  const dimensions = Object.keys(first.sizes).sort();
  const metrics = Object.keys(first.counters).sort().join(" ");
  const sizes = new Set(samples.map((point) => JSON.stringify(dimensions.map((key) => point.sizes[key]))));
  return sizes.size === samples.length && samples.every((point) => dimensions.join(" ") === Object.keys(point.sizes).sort().join(" ")
    && metrics === Object.keys(point.counters).sort().join(" "));
}, "Use distinct sizes and the same dimensions and counters for every sample in a workload.");

export const factoryScalingReport = z.strictObject({
  exitCode: z.int().min(0).max(255),
  workloads: z.array(workload).min(1).max(4),
  counterexamples: z.array(z.strictObject({ description: label(512), proof })).max(8),
});
export const factoryScalingRevision = z.strictObject({
  headOid: z.string().refine(isGitObjectId), baseOid: z.string().refine(isGitObjectId),
});
export const factoryScalingReceiptId = z.string().regex(/^[a-f0-9]{64}$/);

const binding = {
  source: z.literal("operator_attested"), approvalId: z.uuid(),
  repository: label(140), projectKey: label(4096),
};
const details = {
  worktree: label(4096),
  branch: label(255), baseRef: label(255), revision: factoryScalingRevision,
  previousReceiptId: factoryScalingReceiptId.nullable(), report: factoryScalingReport,
};
const content = z.discriminatedUnion("version", [
  z.strictObject({ version: z.literal(1), ...binding, issueId: z.guid(), ...details }),
  z.strictObject({ version: z.literal(2), ...binding,
    workItem: z.unknown().transform((value) => parseFactoryWorkItem({ workItem: value })), ...details }),
]);
const stored = z.strictObject({ receiptId: factoryScalingReceiptId, recordedAt: z.int().min(1), content });
export type FactoryScalingReceipt = z.infer<typeof stored>;

export function matchesFactoryScalingSubject(receipt: FactoryScalingReceipt, subject: {
  approvalId: string; repository: string; projectKey: string; workItem: FactoryWorkItem; worktree: string;
}): boolean {
  const receiptItem = receipt.content.version === 1
    ? { provider: "linear" as const, id: receipt.content.issueId } : receipt.content.workItem;
  return receipt.content.approvalId === subject.approvalId && receipt.content.repository === subject.repository
    && receipt.content.projectKey === subject.projectKey && receipt.content.worktree === subject.worktree
    && factoryWorkItemKey(receiptItem) === factoryWorkItemKey(subject.workItem);
}

export function createFactoryScalingReceipt(content: FactoryScalingReceipt["content"]): FactoryScalingReceipt {
  const receiptId = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return { receiptId, recordedAt: Date.now(), content };
}

export function factoryScalingStatus(
  receipt: FactoryScalingReceipt | undefined, candidate: FactoryCleanCandidate, branch: string, baseRef: string,
): "current" | "stale" | "failed" | "missing" {
  if (!receipt) return "missing";
  const { content: { revision, report } } = receipt;
  if (candidate.state !== "clean" || receipt.content.branch !== branch || receipt.content.baseRef !== baseRef
    || candidate.headOid !== revision.headOid || candidate.baseOid !== revision.baseOid) return "stale";
  const overBudget = report.workloads.some(({ samples }) => samples.some(({ counters }) =>
    Object.values(counters).some(({ measured, bound }) => measured > bound)));
  return report.exitCode !== 0 || overBudget || report.counterexamples.length > 0 ? "failed" : "current";
}

export function factoryScalingReceiptPath(approvalId: string): string {
  return resolveActiveProfilePath(path.join("artifacts", "factory", "scaling", `${approvalId}.json`));
}

export function readFactoryScalingReceipt(file: string): FactoryScalingReceipt | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Invalid Factory scaling receipt file.");
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const size = readSync(fd, buffer);
    if (size > MAX_RECEIPT_BYTES) throw new Error("Factory scaling receipt exceeds 32 KiB.");
    const receipt = stored.parse(JSON.parse(buffer.toString("utf8", 0, size)));
    if (createFactoryScalingReceipt(receipt.content).receiptId !== receipt.receiptId) {
      throw new Error("Factory scaling receipt digest mismatch.");
    }
    return receipt;
  } finally {
    closeSync(fd);
  }
}

export function writeFactoryScalingReceipt(file: string, receipt: FactoryScalingReceipt): void {
  const data = JSON.stringify(receipt);
  if (Buffer.byteLength(data) > MAX_RECEIPT_BYTES) throw new Error("Factory scaling receipt exceeds 32 KiB.");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}
