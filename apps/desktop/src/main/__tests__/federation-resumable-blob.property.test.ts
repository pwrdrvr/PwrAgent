import { createHash, randomInt } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { FEDERATION_PROTOCOL_VERSION } from "@pwragent/shared";
import { pushResumableBlob, type ResumableBlobTransport } from "@pwragent/federation/federation-blob-sender";
import { BLOB_CHUNK_BYTES, BLOB_COMMIT_BYTES, BLOB_RETENTION_MS, FederationResumableBlobReceiver } from "@pwragent/federation/federation-resumable-blob";
import { FederationFilePushReceiver, FILE_PUSH_METHODS } from "../federation/federation-file-push";
import { BlobDurabilityModel } from "./helpers/blob-durability-model";

type DurabilityScope = {
  sync?: (filePath: string, file: FileHandle) => Promise<void>;
  rename?: (source: string, destination: string) => Promise<void>;
  nativeSyncs: number;
};
const durability = vi.hoisted(() => ({ scopes: new Map<string, DurabilityScope>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const scopeFor = (filePath: string): DurabilityScope | undefined => {
    for (const [root, scope] of durability.scopes) {
      if (filePath === root || filePath.startsWith(`${root}${path.sep}`)) return scope;
    }
    return undefined;
  };
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    // Capture the owner when work starts. Another fixture's registration or
    // cleanup cannot change which model an in-flight handle belongs to.
    const scope = scopeFor(String(args[0]));
    const file = await fs.open(...args);
    if (!scope) return file;
    const sync = file.sync.bind(file);
    file.sync = async () => {
      if (scope.sync) return await scope.sync(String(args[0]), file);
      scope.nativeSyncs++;
      await sync();
    };
    return file;
  }, rename: async (...args: Parameters<typeof fs.rename>) => {
    const scope = scopeFor(String(args[0]));
    await fs.rename(...args);
    await scope?.rename?.(String(args[0]), String(args[1]));
  } };
});

type Drop = { event: number; after: boolean };
type TransferStep = {
  event: number;
  phase: string;
  point: "before" | "after";
  generation: number;
  committedOffset: number;
};

async function transferBlob(drops: Drop[], modelDurability: boolean, options: {
  afterBegin?: () => Promise<void>;
  signal?: AbortSignal;
  onStep?: (step: TransferStep) => void;
  dropAfter?: (step: TransferStep) => boolean;
} = {}): Promise<number> {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-model-"));
  const data = Buffer.alloc(4 * 1024 * 1024 + BLOB_CHUNK_BYTES + 3, 0x57);
  const source = path.join(root, "source");
  const received = path.join(root, "received");
  const model = modelDurability ? new BlobDurabilityModel(received) : undefined;
  const scope: DurabilityScope = { nativeSyncs: 0,
    sync: model ? (filePath, file) => model.sync(filePath, file) : undefined,
    rename: model ? (source, destination) => model.rename(source, destination) : undefined,
  };
  durability.scopes.set(root, scope);
  const makeReceiver = () => new FederationFilePushReceiver({ allowed: () => true, directory: () => received });
  let receiver = makeReceiver();
  let generation = 0;
  let event = 0;
  let connected = true;
  let durablePrefix = 0;
  let observedPrefix = 0;
  let begins = 0;
  const beginsPerGeneration = new Set<number>();
  const sentOffsets: number[] = [];
  const cancellations: Promise<unknown>[] = [];
  const drop = async (): Promise<never> => {
    connected = false;
    generation++;
    await receiver.dispose();
    receiver = makeReceiver();
    throw new Error("model: connection dropped");
  };
  const step = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
    event++;
    const snapshot = (point: TransferStep["point"]): TransferStep => ({
      event, phase, point, generation, committedOffset: durablePrefix,
    });
    options.onStep?.(snapshot("before"));
    options.signal?.throwIfAborted();
    if (event > 200) throw new Error("Transfer exceeded the model event budget.");
    const planned = drops.find((item) => item.event === event);
    if (planned && !planned.after) return await drop();
    const result = await work();
    const after = snapshot("after");
    options.onStep?.(after);
    options.signal?.throwIfAborted();
    if (planned?.after || options.dropAfter?.(after)) return await drop();
    return result;
  };
  const transport: ResumableBlobTransport = {
    localInstanceId: "source", targetInstanceId: "receiver",
    waitForReconnect: async () => { options.signal?.throwIfAborted(); connected = true; },
    cancel: (identity) => { cancellations.push(receiver.handle("source", FILE_PUSH_METHODS.cancel, identity)); },
    connection: () => {
      const current = generation;
      return {
        didDisconnect: () => current !== generation,
        rpc: { request: async <T>(request: { method: string; params: unknown; timeoutMs?: number | null }): Promise<T> => {
          expect(connected).toBe(true);
          expect(request.timeoutMs).toBeNull();
          return await step(request.method, async () => {
            const result = await receiver.handle("source", request.method, request.params);
            if (request.method === FILE_PUSH_METHODS.begin) {
              // No logical begin is resent on a connection that stayed up.
              expect(beginsPerGeneration.has(current)).toBe(false);
              beginsPerGeneration.add(current);
              begins++;
              const offset = (result as { committedOffset: number }).committedOffset;
              expect(offset).toBe(durablePrefix);
              await options.afterBegin?.();
            }
            // Model a slow but live acknowledgement, without wall clocks.
            await Promise.resolve();
            await Promise.resolve();
            return result as T;
          });
        } },
        send: async (envelope) => await step(FILE_PUSH_METHODS.chunk, async () => {
          const offset = envelope.chunkIndex * BLOB_CHUNK_BYTES;
          expect(offset).toBeGreaterThanOrEqual(durablePrefix);
          sentOffsets.push(offset);
          await receiver.receiveBlob(envelope);
          const checkpoint = await receiver.handle("source", FILE_PUSH_METHODS.checkpoint, { transferId: envelope.transferId }) as { committedOffset: number };
          const receivedOffset = offset + envelope.data.byteLength;
          const committedOffset = receivedOffset === data.length
            ? receivedOffset : Math.floor(receivedOffset / BLOB_COMMIT_BYTES) * BLOB_COMMIT_BYTES;
          expect(checkpoint).toEqual({ receivedOffset, committedOffset });
          if (model) expect(checkpoint.committedOffset).toBe(model.committedOffset);
          durablePrefix = committedOffset;
        }),
      };
    },
  };
  try {
    await writeFile(source, data);
    const result = await pushResumableBlob(transport, source, "fixture", {
      signal: options.signal,
      onTransferProgress: (progress) => {
        expect(progress.bytesCommitted).toBeGreaterThanOrEqual(observedPrefix);
        observedPrefix = progress.bytesCommitted;
      },
    });
    expect((await readFile(result.path)).equals(data)).toBe(true);
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    expect(durablePrefix).toBe(data.length);
    expect(observedPrefix).toBe(data.length);
    if (generation === 0) {
      expect(begins).toBe(1);
      expect(new Set(sentOffsets).size).toBe(sentOffsets.length);
    }
  } finally {
    try { await Promise.all(cancellations); } finally {
      try { await receiver.dispose(); } finally {
        durability.scopes.delete(root);
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  if (model) {
    expect(scope.nativeSyncs, "generated interleavings must use modeled durability").toBe(0);
  } else {
    expect(scope.nativeSyncs, "integration case must exercise physical syncs").toBeGreaterThan(0);
  }
  return generation;
}

it("commits each prefix once across generated send/ack/drop/restart interleavings", async ({ signal, onTestFailed }) => {
  // Select a fresh seed before starting so Vitest's outer timeout can report
  // it even when fast-check never returns. A configured replay seed still wins.
  const seed = fc.readConfigureGlobal().seed ?? randomInt(0x80000000);
  let current: { case: number; drops: Drop[]; step?: TransferStep } | undefined;
  let caseNumber = 0;
  onTestFailed(() => { console.error("blob-model-replay", JSON.stringify({ seed, current })); });
  await fc.assert(fc.asyncProperty(
    fc.array(fc.record({ event: fc.integer({ min: 1, max: 50 }), after: fc.boolean() }), { maxLength: 4 }),
    async (drops) => {
      signal.throwIfAborted();
      current = { case: ++caseNumber, drops };
      await transferBlob(drops, true, { signal, onStep: (step) => { current = { case: caseNumber, drops, step }; } });
    },
  ), { seed, numRuns: 15, examples: [[[{ event: 20, after: true }]], [[{ event: 25, after: true }]], [[]]] });
});

it("resumes real durable bytes after losing a chunk acknowledgement and the finish receipt", async () => {
  const lost: string[] = [];
  const generation = await transferBlob([], false, { dropAfter: (step) => {
    if (step.phase === FILE_PUSH_METHODS.chunk && step.committedOffset === 4 * BLOB_COMMIT_BYTES
      && !lost.includes("durable chunk acknowledgement")) {
      lost.push("durable chunk acknowledgement");
      return true;
    }
    if (step.phase === FILE_PUSH_METHODS.finish && !lost.includes("finish receipt")) {
      lost.push("finish receipt");
      return true;
    }
    return false;
  } });
  expect(lost).toEqual(["durable chunk acknowledgement", "finish receipt"]);
  expect(generation).toBe(lost.length);
});

it("another fixture's work and cleanup cannot change a suspended transfer's durability", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async (secondModeled) => {
    let entered!: () => void;
    let release!: () => void;
    const suspended = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = transferBlob([], true, { afterBegin: async () => { entered(); await blocked; } });
    try {
      await Promise.race([suspended, first.then(() => { throw new Error("First fixture never suspended."); })]);
      await transferBlob([], secondModeled);
      release();
      await first;
    } finally {
      release();
      await Promise.allSettled([first]);
    }
  }), { numRuns: 2, examples: [[false], [true]] });
});

it("checkpoints and disconnects wait for every generated durability fence", async () => {
  const lastFence = process.platform === "win32" ? 1 : 3;
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: lastFence }), async (fence) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blob-fence-"));
    const model = new BlobDurabilityModel(root);
    const scope: DurabilityScope = { nativeSyncs: 0,
      sync: (filePath, file) => model.sync(filePath, file),
      rename: (source, destination) => model.rename(source, destination),
    };
    durability.scopes.set(root, scope);
    const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
    const data = Buffer.alloc(BLOB_COMMIT_BYTES, 0x57);
    const sha256 = createHash("sha256").update(data).digest("hex");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const syncing = new Promise<void>((resolve) => { entered = resolve; });
    const settled: string[] = [];
    const pending: Promise<unknown>[] = [];
    try {
      const begin = await receiver.handle("source", FILE_PUSH_METHODS.begin, {
        name: "fixture", binary: true, sha256, sizeBytes: data.length,
      }) as { transferId: string };
      const chunk = (chunkIndex: number) => receiver.receiveBlob({
        id: `fixture:${chunkIndex}`, kind: "blob_chunk", purpose: "file_push",
        protocolVersion: FEDERATION_PROTOCOL_VERSION, sourceInstanceId: "source", targetInstanceId: "target",
        createdAt: 0, transferId: begin.transferId, chunkIndex, chunkCount: 4,
        totalSize: data.length, sha256, name: "fixture", inputType: "localFile",
        data: data.subarray(chunkIndex * BLOB_CHUNK_BYTES, (chunkIndex + 1) * BLOB_CHUNK_BYTES),
      });
      for (let i = 0; i < 3; i++) await chunk(i);
      let syncIndex = 0;
      let waiting = false;
      scope.sync = async (filePath, file) => {
        expect(waiting, "durability fences cannot overlap").toBe(false);
        if (syncIndex++ === fence) {
          waiting = true;
          entered();
          await blocked;
          waiting = false;
        }
        await model.sync(filePath, file);
      };
      const sending = chunk(3).then(() => { settled.push("chunk"); });
      pending.push(sending);
      // If a fence disappears or stops being awaited, fail rather than wait
      // forever for a synchronization point that can no longer be reached.
      await Promise.race([syncing, sending.then(() => { throw new Error("Chunk finished before its durability fence."); })]);
      const checkpoint = receiver.handle("source", FILE_PUSH_METHODS.checkpoint, begin)
        .then((result) => { settled.push("checkpoint"); return result; });
      const disconnect = receiver.disconnect("source").then(() => { settled.push("disconnect"); });
      pending.push(checkpoint, disconnect);
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toEqual([]);
      release();
      await sending;
      expect(await checkpoint).toEqual({ receivedOffset: data.length, committedOffset: data.length });
      await disconnect;
      expect(settled).toEqual(["chunk", "checkpoint", "disconnect"]);
      expect(model.committedOffset).toBe(data.length);
      await expect(receiver.handle("source", FILE_PUSH_METHODS.begin, {
        name: "fixture", binary: true, sha256, sizeBytes: data.length,
      })).resolves.toMatchObject({ committedOffset: data.length });
    } finally {
      release();
      await Promise.allSettled(pending);
      try { await receiver.dispose(); } finally {
        durability.scopes.delete(root);
        await rm(root, { recursive: true, force: true });
      }
    }
  }), { numRuns: 8, examples: Array.from({ length: lastFence + 1 }, (_, fence): [number] => [fence]) });
});

it("cancel removes the part file and sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-cancel-"));
  const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
  try {
    const identity = { sha256: "0".repeat(64), sizeBytes: 1 };
    await receiver.handle("source", FILE_PUSH_METHODS.begin, { ...identity, name: "fixture", binary: true });
    await receiver.handle("source", FILE_PUSH_METHODS.cancel, identity);
    expect(await readdir(path.join(root, ".pwragent-resumable"))).toEqual([]);
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("expires abandoned partials after 24 hours using the receiver's clock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-expiry-"));
  let now = Date.now();
  const receiver = new FederationResumableBlobReceiver({ directory: () => root, now: () => now });
  try {
    await receiver.begin("source", { sha256: "0".repeat(64), sizeBytes: 1, name: "old" });
    now += BLOB_RETENTION_MS - 1000;
    await receiver.disconnect("source");
    const [old] = await readdir(path.join(root, ".pwragent-resumable"));
    now += 2000;
    await receiver.initialize();
    expect(await readdir(path.join(root, ".pwragent-resumable"))).toContain(old);
    now += BLOB_RETENTION_MS;
    await receiver.initialize();
    await receiver.begin("source", { sha256: "1".repeat(64), sizeBytes: 1, name: "new" });
    expect(await readdir(path.join(root, ".pwragent-resumable"))).not.toContain(old);
  } finally {
    await receiver.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it("cancels promptly while the socket has a blocked blob send", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "blob-abort-"));
  const controller = new AbortController();
  let release!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cancelled = false;
  try {
    const source = path.join(root, "source");
    await writeFile(source, "fixture");
    const transfer = pushResumableBlob({ localInstanceId: "source", targetInstanceId: "target",
      connection: () => ({ didDisconnect: () => false,
        rpc: { request: async <T>() => ({ transferId: "blob:fixture", committedOffset: 0 }) as T },
        send: async () => { entered(); await blocked; },
      }), waitForReconnect: async () => undefined, cancel: () => { cancelled = true; },
    }, source, "fixture", { signal: controller.signal });
    const failure = transfer.catch((error: unknown) => error);
    await sending;
    controller.abort(new Error("fixture cancelled"));
    expect((await failure as Error).message).toBe("fixture cancelled");
    expect(cancelled).toBe(true);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

it("one send cannot replace or cancel another send of identical content", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.uuid(), async (first, second) => {
    fc.pre(first !== second);
    const root = await mkdtemp(path.join(os.tmpdir(), "blob-ownership-"));
    const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root });
    const identity = { sha256: "0".repeat(64), sizeBytes: 1 };
    try {
      const active = await receiver.handle("source", FILE_PUSH_METHODS.begin, {
        ...identity, name: "fixture", binary: true, senderToken: first,
      }) as { transferId: string };
      await expect(receiver.handle("source", FILE_PUSH_METHODS.begin, {
        ...identity, name: "fixture", binary: true, senderToken: second,
      })).rejects.toThrow("another send");
      await receiver.handle("source", FILE_PUSH_METHODS.cancel, { ...identity, senderToken: second });
      await expect(receiver.handle("source", FILE_PUSH_METHODS.checkpoint, active)).resolves.toMatchObject({ committedOffset: 0 });
    } finally {
      await receiver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 10 });
});

it("peer-supplied begin fields cannot forge a completed file receipt", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 128 }), async (sizeBytes) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "blob-receipt-"));
    const completed: unknown[] = [];
    const receiver = new FederationFilePushReceiver({ allowed: () => true, directory: () => root,
      onCompleted: (_peer, file) => { completed.push(file); } });
    try {
      const victim = path.join(root, "other-owned-fixture");
      await writeFile(victim, Buffer.alloc(sizeBytes));
      const begin = await receiver.handle("source", FILE_PUSH_METHODS.begin, {
        name: "fixture", binary: true, sha256: "0".repeat(64), sizeBytes,
        result: { path: victim, sizeBytes, sha256: "0".repeat(64) },
        committedOffset: sizeBytes, receivedOffset: sizeBytes,
      }) as { transferId: string };
      await expect(receiver.handle("source", FILE_PUSH_METHODS.finish, begin)).rejects.toThrow("Incomplete blob");
      expect(completed).toEqual([]);
    } finally {
      await receiver.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }), { numRuns: 10 });
});
