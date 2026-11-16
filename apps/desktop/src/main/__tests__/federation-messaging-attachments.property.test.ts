import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import fc from "fast-check";
import type { PwrAgentMessagingRequest } from "@pwragent/shared";
import { FederationMessagingAttachmentExports } from "../federation/federation-messaging-attachments";
import { setFederationMessagingDestinationHandler } from "../federation/federation-messaging-tools";
import { MessagingOriginalAttachmentStore, ORIGINAL_ATTACHMENT_RETENTION_MS } from "../messaging/core/messaging-original-attachment-store";

const roots: string[] = [];
afterEach(async () => {
  setFederationMessagingDestinationHandler(undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(data: Uint8Array, receiverClockOffsetMs = 0) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-reverse-export-"));
  roots.push(root);
  let now = Date.now();
  let sendAllowed = true;
  let receiveAllowed = true;
  let authorized = true;
  let afterTransfer: (() => Promise<void>) | undefined;
  let intercept: ((method: string, params: Record<string, unknown>) => Promise<void>) | undefined;
  const ownerRoot = path.join(root, "owner-profile");
  const destinationRoot = path.join(root, "execution-profile");
  const scope = { backend: "codex", threadId: "thread", provider: "fixture", instanceId: "execution-owner" };
  const actorKey = MessagingOriginalAttachmentStore.actorKey("conversation", "human");
  const ownerStore = new MessagingOriginalAttachmentStore(ownerRoot, () => now);
  const attachment = await ownerStore.retain({ data, name: "../../private/provider-file.pdf", mimeType: "application/pdf",
    scope, actorKey, eventId: "human-message", attachmentKey: "private-provider-id" });
  const request = { operation: "export_messaging_attachment", context: { backend: "codex", threadId: "thread", turnId: "turn",
    causalMessagingSource: { instanceId: "provider-owner", ownerId: "profile-identity", requestId: "human-request" } },
    args: { attachmentId: attachment.attachmentId } } satisfies PwrAgentMessagingRequest;
  const receipts: Record<string, unknown>[] = [];
  let destination: FederationMessagingAttachmentExports;
  const owner = new FederationMessagingAttachmentExports({ directory: ownerRoot, now: () => now,
    receiveAllowed: () => false, sendAllowed: () => sendAllowed,
    rpc: () => ({ request: async <T>(call: { method: string; params?: unknown }): Promise<T> => {
      const params = call.params as Record<string, unknown>;
      receipts.push(structuredClone(params));
      await intercept?.(String(params.method), params);
      return await destination.handle("provider-owner", params, false) as T;
    } }) });
  const createDestination = () => new FederationMessagingAttachmentExports({ directory: destinationRoot, now: () => now + receiverClockOffsetMs,
    receiveAllowed: () => receiveAllowed, sendAllowed: () => false,
    rpc: () => ({ request: async <T>(call: { params?: unknown }): Promise<T> => await owner.handle("execution-owner", call.params, false) as T }) });
  destination = createDestination();
  setFederationMessagingDestinationHandler(async (operation, caller, _contained, consume) => {
    const input = operation.kind === "request" ? operation.request : undefined;
    if (!authorized || caller !== "execution-owner" || input?.context.backend !== "codex" || input.context.threadId !== "thread"
      || JSON.stringify(input.context.causalMessagingSource) !== JSON.stringify(request.context.causalMessagingSource)) {
      return { ok: false, error: { code: "forbidden", message: "No source authority" } };
    }
    if (input.operation === "list_messaging_attachments") return { ok: true, data: await ownerStore.list(scope, actorKey) };
    if (input.operation !== "export_messaging_attachment" || !consume) throw new Error("Expected a reverse exporter");
    const original = await ownerStore.read(scope, input.args.attachmentId, actorKey);
    const response = await consume(original, async () => authorized && now < attachment.expiresAt);
    // The real controller also rechecks retention and source authority after
    // the transfer. This fixture's provider file store is the byte oracle.
    await ownerStore.read(scope, input.args.attachmentId, actorKey);
    await afterTransfer?.();
    return response;
  });
  return { root, ownerRoot, destinationRoot, ownerStore, owner, request, attachment, receipts,
    destination: () => destination,
    restart: async () => { await destination.reset(); destination = createDestination(); },
    intercept: (callback: typeof intercept) => { intercept = callback; },
    afterTransfer: (callback: typeof afterTransfer) => { afterTransfer = callback; },
    revoke: (kind: "send" | "receive" | "actor") => {
      if (kind === "send") sendAllowed = false;
      if (kind === "receive") receiveAllowed = false;
      if (kind === "actor") authorized = false;
    },
    advance: (ms: number) => { now += ms; },
  };
}

async function assertClockSkewRoundTrip(ownerAheadMs: number, data: Uint8Array): Promise<void> {
  const f = await fixture(data, -ownerAheadMs);
  const listed = await f.destination().request("provider-owner", { ...f.request, operation: "list_messaging_attachments", args: {} });
  expect(listed).toMatchObject({ ok: true, data: { attachments: [f.attachment] } });
  const response = await f.destination().request("provider-owner", f.request);
  expect(response).toMatchObject({ ok: true, data: { attachment: f.attachment } });
  if (!response.ok || !("path" in response.data)) throw new Error("Expected a destination-local original despite clock skew");
  expect(await readFile(response.data.path)).toEqual(Buffer.from(data));
  await rm(f.root, { recursive: true, force: true });
}

it("lists and exports a fresh original when the messaging owner's clock is ten seconds ahead", async () => {
  await assertClockSkewRoundTrip(10_000, Buffer.from("synthetic original"));
});

it("owner clock offsets do not change listing or verified original bytes before expiry", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 60_000 }), fc.uint8Array({ maxLength: 128 }),
    assertClockSkewRoundTrip), { numRuns: 8 });
});

it("still rejects originals at the receiver's expiry boundary", async () => {
  const f = await fixture(Buffer.from("expired on receiver"), ORIGINAL_ATTACHMENT_RETENTION_MS);
  expect(await f.destination().request("provider-owner", { ...f.request, operation: "list_messaging_attachments", args: {} }))
    .toMatchObject({ ok: false });
  await expect(f.destination().request("provider-owner", f.request)).rejects.toThrow("metadata");
});

it.each([-1, 1])("still rejects an original with a retention interval changed by %s ms", async (delta) => {
  const f = await fixture(Buffer.from("invalid retention"), -10_000);
  f.intercept(async (method, params) => {
    if (method === "file.push.begin") (params.attachment as { expiresAt: number }).expiresAt += delta;
  });
  await expect(f.destination().request("provider-owner", f.request)).rejects.toThrow("metadata");
});

it("exports arbitrary original bytes to the execution owner without transferring paths or changing previews", async () => {
  await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (data) => {
    const f = await fixture(data);
    const preview = path.join(f.root, "existing-preview.png");
    await writeFile(preview, "synthetic preview");
    const response = await f.destination().request("provider-owner", f.request);
    expect(response).toMatchObject({ ok: true });
    if (!response.ok || !("path" in response.data)) throw new Error("Expected a destination-local path");
    expect(path.relative(f.destinationRoot, response.data.path)).not.toMatch(/^\.\./u);
    expect(await readFile(response.data.path)).toEqual(Buffer.from(data));
    expect(createHash("sha256").update(await readFile(response.data.path)).digest("hex")).toBe(f.attachment.sha256);
    expect(JSON.stringify(f.receipts)).not.toContain(f.ownerRoot);
    expect(JSON.stringify(response)).not.toContain(f.ownerRoot);
    expect(await readFile(path.join(f.ownerRoot, f.attachment.attachmentId, "original"))).toEqual(Buffer.from(data));
    expect(await readFile(preview, "utf8")).toBe("synthetic preview");
    const chosen = path.join(f.root, "user-selected.pdf");
    // Final save remains an ordinary backend filesystem operation. The
    // service has no destination argument and cannot overwrite this file.
    await copyFile(response.data.path, chosen, constants.COPYFILE_EXCL);
    await expect(copyFile(response.data.path, chosen, constants.COPYFILE_EXCL)).rejects.toMatchObject({ code: "EEXIST" });
    await expect(f.destination().handle("provider-owner", f.receipts[0], false)).rejects.toThrow("receipt");
    await f.restart();
    await expect(f.destination().handle("provider-owner", f.receipts[0], false)).rejects.toThrow("receipt");
    const repeated = await f.destination().request("provider-owner", f.request);
    expect(repeated).toMatchObject({ ok: true });
    expect(await readdir(path.join(f.destinationRoot, ".receiving"))).toEqual([]);
    await rm(f.root, { recursive: true, force: true });
  }), { numRuns: 12 });
});

it.each(["send", "receive", "actor"] as const)("revoking %s permission during a transfer cannot redeem the receipt", async (permission) => {
  const f = await fixture(Buffer.alloc(256 * 1024 + 1, 42));
  f.intercept(async (method) => { if (method === "file.push.chunk") f.revoke(permission); });
  const response = await f.destination().request("provider-owner", f.request).catch(() => ({ ok: false }));
  expect(response).toMatchObject({ ok: false });
  expect((await readdir(f.destinationRoot)).filter((name) => name !== ".receiving")).toEqual([]);
});

it.each(["send", "receive", "restart"] as const)("a late %s change during final owner checks cannot acknowledge the export", async (change) => {
  const f = await fixture(Buffer.from("verified but unacknowledged"));
  f.afterTransfer(async () => {
    if (change === "restart") await f.owner.reset();
    else f.revoke(change);
  });
  expect(await f.destination().request("provider-owner", f.request)).toMatchObject({ ok: false });
  expect((await readdir(f.destinationRoot)).filter((name) => name !== ".receiving")).toEqual([]);
});

it.each(["receipt", "original", "restart", "source-restart", "wrong-peer", "wrong-member", "size", "checksum"] as const)("refuses %s changes before publication", async (change) => {
  const f = await fixture(Buffer.from("synthetic original"));
  f.intercept(async (method, params) => {
    if (method === "file.push.finish" && change === "source-restart") await f.owner.reset();
    if (method !== "file.push.begin") return;
    if (change === "receipt") f.advance(5 * 60_000);
    if (change === "original") f.advance(ORIGINAL_ATTACHMENT_RETENTION_MS);
    if (change === "restart") await f.restart();
    if (change === "wrong-peer") await expect(f.destination().handle("unrelated-peer", params, false)).rejects.toThrow("receipt");
    if (change === "wrong-member") (params.attachment as { attachmentId: string }).attachmentId = "f".repeat(64);
    if (change === "size") (params.input as { sizeBytes: number }).sizeBytes += 1;
    if (change === "checksum") (params.attachment as { sha256: string }).sha256 = "0".repeat(64);
  });
  const response = await f.destination().request("provider-owner", f.request).catch(() => ({ ok: false }));
  expect(response.ok).toBe(change === "wrong-peer");
});

it("the provider owner bounds pending original reads independently of the destination", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 8 }), async (count) => {
    const f = await fixture(Buffer.from("bounded snapshot"));
    let entered = 0;
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    setFederationMessagingDestinationHandler(async () => {
      entered++;
      await barrier;
      return { ok: false, error: { code: "forbidden", message: "Synthetic held read" } };
    });
    const calls = Array.from({ length: count }, () => f.owner.handle("execution-owner", {
      kind: "request", request: f.request, receiptId: "synthetic-pending-export",
    }, false));
    try {
      expect(entered).toBe(4);
      for (const result of calls.slice(4)) expect(await result).toMatchObject({ ok: false });
    } finally {
      resume();
      await Promise.allSettled(calls);
    }
  }), { numRuns: 4 });
});

it("an unsolicited transfer or a cache path from an old peer cannot stand in for a local receipt", async () => {
  const f = await fixture(Buffer.from("original"));
  await expect(f.destination().handle("provider-owner", { kind: "receive", receiptId: "invented",
    method: "file.push.begin", input: { name: "original", sizeBytes: 8 }, attachment: f.attachment }, false)).rejects.toThrow("receipt");
  setFederationMessagingDestinationHandler(async () => ({ ok: true, data: { attachment: f.attachment,
    path: path.join(f.ownerRoot, "must-never-resolve"), guidance: "untrusted owner path" } }));
  expect(await f.destination().request("provider-owner", f.request)).toMatchObject({ ok: false });
});

it("simultaneous exports obey the four-receipt bound before any filesystem await", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 5, max: 8 }), async (count) => {
    const f = await fixture(Buffer.from("bounded original"));
    let entered = 0;
    let allEntered!: () => void;
    const ready = new Promise<void>((resolve) => { allEntered = resolve; });
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => { resume = resolve; });
    let overflow!: () => void;
    const exceeded = new Promise<"overflow">((resolve) => { overflow = () => resolve("overflow"); });
    // An independent peer oracle holds accepted requests without applying
    // its own sender cap, so it cannot hide a broken destination bound.
    const destination = new FederationMessagingAttachmentExports({ directory: f.destinationRoot,
      receiveAllowed: () => true, sendAllowed: () => false,
      rpc: () => ({ request: async <T>(): Promise<T> => {
        entered++;
        if (entered === 4) allEntered();
        if (entered > 4) overflow();
        await barrier;
        return { ok: false, error: { code: "forbidden", message: "Synthetic held request" } } as T;
      } }) });
    const calls = Array.from({ length: count }, () => destination.request("provider-owner", f.request));
    try {
      await ready;
      const outcome = await Promise.race([Promise.all(calls.slice(4)).then(() => "bounded"), exceeded]);
      expect(outcome).toBe("bounded");
    } finally {
      resume();
      await Promise.allSettled(calls);
    }
    expect(entered).toBe(4);
  }), { numRuns: 4 });
});
