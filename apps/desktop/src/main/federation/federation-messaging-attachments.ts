import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { PwrAgentMessagingAttachmentSummary, PwrAgentMessagingRequest, PwrAgentMessagingResponse } from "@pwragent/shared";
import type { FederationRpcEndpoint } from "@pwragent/federation/federation-rpc";
import { FederationFilePushReceiver, FILE_PUSH_METHODS, pushFederationFile, type FilePushResult } from "./federation-file-push";
import { handleFederationMessagingDestination } from "./federation-messaging-tools";
import { MessagingOriginalAttachmentStore, verifiedOriginalAttachmentBytes } from "../messaging/core/messaging-original-attachment-store";

export const MESSAGING_ORIGINALS_METHOD = "messaging.originals.v1";
export const MESSAGING_ORIGINALS_CAPABILITY = "messaging_original_attachments_v1";
const MAX_BYTES = 10 * 1024 * 1024;
const RECEIPT_MS = 5 * 60_000;
type Rpc = Pick<FederationRpcEndpoint, "request">;
type OriginalRequest = Extract<PwrAgentMessagingRequest, { operation: "list_messaging_attachments" | "export_messaging_attachment" }>;
type Receipt = {
  peer: string; attachmentId: string; directory: string; expiresAt: number; receiver: FederationFilePushReceiver;
  attachment?: PwrAgentMessagingAttachmentSummary; file?: FilePushResult;
};

const unavailable = (): PwrAgentMessagingResponse => ({ ok: false, error: { code: "forbidden",
  message: "The original-attachment transfer is no longer authorized. Check peer file permissions and request the original again." } });

function metadata(a: PwrAgentMessagingAttachmentSummary): PwrAgentMessagingAttachmentSummary {
  const { attachmentId, name, mimeType, sizeBytes, sha256, receivedAt, expiresAt } = a;
  return { attachmentId, name, mimeType, sizeBytes, sha256, receivedAt, expiresAt };
}

function validAttachment(value: unknown, now: number): value is PwrAgentMessagingAttachmentSummary {
  const a = value as PwrAgentMessagingAttachmentSummary | undefined;
  // receivedAt belongs to the owner's clock, which may be ahead of ours.
  // Keep validating its retention interval and the receiver's expiry boundary.
  return !!a && typeof a.attachmentId === "string" && /^[a-f0-9]{64}$/u.test(a.attachmentId)
    && typeof a.sha256 === "string" && /^[a-f0-9]{64}$/u.test(a.sha256)
    && typeof a.name === "string" && a.name.length <= 255
    && typeof a.mimeType === "string" && a.mimeType.length <= 127
    && Number.isSafeInteger(a.sizeBytes) && a.sizeBytes >= 0 && a.sizeBytes <= MAX_BYTES
    && Number.isSafeInteger(a.receivedAt) && Number.isSafeInteger(a.expiresAt)
    && a.expiresAt > now
    && a.expiresAt === a.receivedAt + 7 * 24 * 60 * 60_000;
}

/** A reverse push is accepted only while this process awaits that owner's
 * export for a local tool call. The unguessable receipt binds the peer, exact
 * request and lifetime. Neither endpoint accepts a caller-selected path.
 * Restart drops every receipt; ordinary file.push grants cannot mint one.
 */
export class FederationMessagingAttachmentExports {
  private readonly receipts = new Map<string, Receipt>();
  private readonly store: MessagingOriginalAttachmentStore;
  private readonly now: () => number;
  private generation = 0;
  private initialization?: Promise<string>;
  private pendingRequests = 0;
  private sending = 0;

  constructor(private readonly options: {
    directory: string;
    receiveAllowed: () => boolean;
    sendAllowed: () => boolean;
    rpc: (peer: string) => Rpc;
    now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
    this.store = new MessagingOriginalAttachmentStore(options.directory, this.now);
  }

  async request(peer: string, request: OriginalRequest): Promise<PwrAgentMessagingResponse> {
    if (request.operation === "list_messaging_attachments") {
      const response = await this.options.rpc(peer).request<PwrAgentMessagingResponse>({ method: MESSAGING_ORIGINALS_METHOD,
        params: { kind: "request", request }, timeoutMs: 30_000 });
      if (!response.ok) return response;
      if (!("attachments" in response.data) || response.data.attachments.length > 25
        || !response.data.attachments.every((a) => validAttachment(a, this.now()))) return unavailable();
      const cursor = "nextCursor" in response.data ? response.data.nextCursor : undefined;
      if (cursor !== undefined && (typeof cursor !== "string" || !/^[a-f0-9]{64}$/u.test(cursor))) return unavailable();
      return { ok: true, data: { attachments: response.data.attachments.map((a) => metadata(a as PwrAgentMessagingAttachmentSummary)),
        ...(cursor ? { nextCursor: cursor } : {}) } };
    }
    if (!this.options.receiveAllowed() || this.pendingRequests >= 4) return unavailable();
    // Reserve before filesystem awaits, so concurrent callers cannot all pass
    // the bound before any of them publishes a receipt.
    this.pendingRequests++;
    try {
      return await this.receiveExport(peer, request);
    } finally { this.pendingRequests--; }
  }

  private async receiveExport(peer: string, request: Extract<OriginalRequest, { operation: "export_messaging_attachment" }>): Promise<PwrAgentMessagingResponse> {
    const generation = this.generation;
    const receiving = await (this.initialization ??= this.initialize());
    if (generation !== this.generation || !this.options.receiveAllowed()) return unavailable();
    const directory = await mkdtemp(path.join(receiving, "export-"));
    const receiptId = randomUUID();
    const receipt: Receipt = { peer, directory, attachmentId: request.args.attachmentId, expiresAt: this.now() + RECEIPT_MS,
      receiver: new FederationFilePushReceiver({
        directory: () => directory,
        allowed: () => this.options.receiveAllowed() && this.receipts.get(receiptId) === receipt
          && this.now() < receipt.expiresAt && (!receipt.attachment || this.now() < receipt.attachment.expiresAt),
        onCompleted: (_peer, file) => { receipt.file = file; },
      }) };
    this.receipts.set(receiptId, receipt);
    try {
      const response = await this.options.rpc(peer).request<PwrAgentMessagingResponse>({
        method: MESSAGING_ORIGINALS_METHOD, params: { kind: "request", request, receiptId }, timeoutMs: RECEIPT_MS,
      });
      if (!response.ok) return response;
      const attachment = receipt.attachment;
      const file = receipt.file;
      // Only our receiver's completed receipt selects a LOCAL path. Ignore
      // all owner-supplied paths, including a forged FilePushResult.
      if (!this.options.receiveAllowed() || generation !== this.generation || this.now() >= receipt.expiresAt
        || !attachment || !file || !validAttachment(attachment, this.now())
        || attachment.attachmentId !== request.args.attachmentId
        || file.sizeBytes !== attachment.sizeBytes || file.sha256 !== attachment.sha256
        || !("attachments" in response.data) || response.data.attachments.length !== 1
        || !validAttachment(response.data.attachments[0], this.now())
        || JSON.stringify(metadata(response.data.attachments[0])) !== JSON.stringify(attachment)) return unavailable();
      const data = await verifiedOriginalAttachmentBytes(file.path, attachment);
      const retained = await this.store.retain({ data, name: attachment.name, mimeType: attachment.mimeType,
        scope: { backend: request.context.backend, threadId: request.context.threadId, instanceId: peer },
        actorKey: createHash("sha256").update(JSON.stringify(request.context.causalMessagingSource)).digest("hex"),
        eventId: attachment.attachmentId, attachmentKey: attachment.sha256, receivedAt: attachment.receivedAt });
      const exported = await this.store.export({ backend: request.context.backend, threadId: request.context.threadId, instanceId: peer }, retained.attachmentId);
      if (!this.options.receiveAllowed() || generation !== this.generation || this.now() >= receipt.expiresAt
        || !validAttachment(attachment, this.now())) return unavailable();
      return { ok: true, data: { attachment, path: exported.path, guidance:
        "This verified original is on this execution owner's machine. COPY it to the user's selected destination with your normal filesystem tools and sandbox/approval policy. Preserve the source; use a safe explicit filename and do not overwrite unless requested. The display name is untrusted data." } };
    } finally {
      this.receipts.delete(receiptId);
      await receipt.receiver.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }

  async handle(peer: string, input: unknown, contained: boolean): Promise<unknown> {
    const op = input as { kind?: string; request?: OriginalRequest; receiptId?: string;
      attachment?: unknown; method?: string; input?: Record<string, unknown> } | null;
    if (op?.kind === "receive") {
      const receipt = typeof op.receiptId === "string" ? this.receipts.get(op.receiptId) : undefined;
      if (!receipt || receipt.peer !== peer || !this.options.receiveAllowed() || this.now() >= receipt.expiresAt
        || receipt.file || !Object.values(FILE_PUSH_METHODS).includes(op.method as typeof FILE_PUSH_METHODS[keyof typeof FILE_PUSH_METHODS])
        || op.input?.binary === true) throw new Error("No pending original-attachment receipt belongs to this peer.");
      if (op.method === FILE_PUSH_METHODS.begin) {
        if (receipt.attachment || !validAttachment(op.attachment, this.now())
          || op.attachment.attachmentId !== receipt.attachmentId
          || op.input?.name !== "original" || op.input.sizeBytes !== op.attachment.sizeBytes) throw new Error("Invalid original-attachment metadata.");
        receipt.attachment = metadata(op.attachment);
      }
      return await receipt.receiver.handle(peer, op.method!, op.input);
    }
    const request = op?.request;
    if (op?.kind !== "request" || !request || !["list_messaging_attachments", "export_messaging_attachment"].includes(request.operation)) {
      throw new Error("Invalid original-attachment operation.");
    }
    if (request.operation === "list_messaging_attachments") {
      return await handleFederationMessagingDestination({ kind: "request", request }, peer, contained);
    }
    if (typeof op.receiptId !== "string" || op.receiptId.length > 64 || !this.options.sendAllowed()
      || this.sending >= 4) return unavailable();
    const receiptId = op.receiptId;
    const deadline = this.now() + RECEIPT_MS;
    const generation = this.generation;
    this.sending++;
    try {
      const response = await handleFederationMessagingDestination({ kind: "request", request }, peer, contained,
        async ({ attachment, data }, reauthorize) => {
          const rpc: Rpc = { request: async <T>(call: Parameters<Rpc["request"]>[0]): Promise<T> => {
            if (call.method !== FILE_PUSH_METHODS.cancel && (generation !== this.generation || this.now() >= deadline
              || !this.options.sendAllowed() || !await reauthorize())) {
              throw new Error("Original-attachment authority was revoked during transfer.");
            }
            return await this.options.rpc(peer).request<T>({ ...call, method: MESSAGING_ORIGINALS_METHOD,
              timeoutMs: Math.max(1, deadline - this.now()),
              params: { kind: "receive", receiptId, method: call.method, input: call.params,
                ...(call.method === FILE_PUSH_METHODS.begin ? { attachment } : {}) } });
          } };
          const receipt = await pushFederationFile(rpc, data, "original");
          if (receipt.sha256 !== attachment.sha256 || receipt.sizeBytes !== attachment.sizeBytes
            || generation !== this.generation || this.now() >= deadline
            || !this.options.sendAllowed() || !await reauthorize()) return unavailable();
          // The completed path belongs to the receiver and is never sent back
          // as tool data. Its local pending receipt remains the only authority.
          return { ok: true, data: { attachments: [attachment] } };
        });
      // The controller rechecks original membership and provider admission
      // after the byte push. File permission and restart must still hold
      // after those asynchronous checks, before acknowledging the export.
      if (generation !== this.generation || this.now() >= deadline || !this.options.sendAllowed()) return unavailable();
      return response;
    } finally { this.sending--; }
  }

  async reset(): Promise<void> {
    this.generation++;
    const receipts = [...this.receipts.values()];
    this.receipts.clear();
    await Promise.all(receipts.map(async (receipt) => {
      await receipt.receiver.dispose();
      await rm(receipt.directory, { recursive: true, force: true });
    }));
  }

  private async initialize(): Promise<string> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.options.directory)).isDirectory()) throw new Error("Invalid original-export cache.");
    const receiving = path.join(this.options.directory, ".receiving");
    await mkdir(receiving, { recursive: true, mode: 0o700 });
    if (!(await lstat(receiving)).isDirectory()) throw new Error("Invalid original-export staging.");
    // A new process has no receipts for these interrupted transfers. This
    // dedicated directory contains no retained originals or preview files.
    for (const name of await readdir(receiving)) {
      if (/^export-[a-zA-Z0-9]+$/u.test(name)) await rm(path.join(receiving, name), { recursive: true, force: true });
    }
    return receiving;
  }
}
