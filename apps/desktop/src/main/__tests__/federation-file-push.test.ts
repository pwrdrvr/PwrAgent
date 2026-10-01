import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint as Rpc } from "../federation/federation-rpc";
import {
  FederationFilePushReceiver, FILE_PUSH_CHUNK_BYTES, FILE_PUSH_MAX_BYTES,
  FILE_PUSH_METHODS as methods, FILE_PUSH_METHOD_CAPABILITIES,
  pushFederationFile, registerFilePushHandlers,
} from "../federation/federation-file-push";

describe("Federation push files", () => {
  let root: string;
  let downloads: string;
  let receiver: FederationFilePushReceiver;
  let allowed: boolean;
  const peer = "pwr_sender";
  const call = (method: string, params: unknown, sender = peer) => receiver.handle(sender, method, params);
  const begin = async (name = "report.txt", sizeBytes = 3) => await call(methods.begin, { name, sizeBytes }) as { transferId: string };
  const digest = (content: string) => createHash("sha256").update(content).digest("hex");

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-file-push-")));
    downloads = path.join(root, "Downloads");
    allowed = true;
    receiver = new FederationFilePushReceiver({ allowed: () => allowed, directory: () => downloads });
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await receiver.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("streams multiple chunks through authenticated relay routing and preserves collisions", async () => {
    const owner = new FederationRouter({ localInstanceId: "pwr_receiver", trustedRelayPeerId: "pwr_gateway", methodCapabilities: FILE_PUSH_METHOD_CAPABILITIES });
    registerFilePushHandlers(owner, receiver);
    const gateway = new FederationRouter({ localInstanceId: "pwr_gateway", methodCapabilities: FILE_PUSH_METHOD_CAPABILITIES });
    const rpc = new Rpc({ localInstanceId: peer, remoteInstanceId: "pwr_receiver", sendEnvelope: (envelope) => { void gateway.routeEnvelope({ envelope, sourcePeerId: peer }); } });
    owner.registerConnection({ peerId: "pwr_gateway", capabilities: ["file_push", "gateway_relay"], sendEnvelope: (envelope) => { void gateway.routeEnvelope({ envelope, sourcePeerId: "pwr_receiver" }); } });
    gateway.registerConnection({ peerId: peer, capabilities: ["file_push", "gateway_relay"], sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
    gateway.registerConnection({ peerId: "pwr_receiver", capabilities: ["file_push", "gateway_relay"], sendEnvelope: (envelope) => { void owner.routeEnvelope({ envelope, sourcePeerId: "pwr_gateway" }); } });
    const source = path.join(root, "report.txt");
    const content = Buffer.alloc(FILE_PUSH_CHUNK_BYTES * 2 + 7, 42);
    await fs.writeFile(source, content);
    await fs.mkdir(downloads);
    await fs.writeFile(path.join(downloads, "report.txt"), "existing");
    const result = await pushFederationFile(rpc, source);
    expect(result.path).toBe(path.join(downloads, "report (1).txt"));
    expect(await fs.readFile(result.path)).toEqual(content);
    expect(await fs.readFile(path.join(downloads, "report.txt"), "utf8")).toBe("existing");
    expect(await fs.readdir(downloads)).toEqual(["report (1).txt", "report.txt"]);
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("rejects disabled receivers before touching the destination", async () => {
    allowed = false;
    await expect(begin()).rejects.toThrow("does not allow");
    await expect(fs.stat(downloads)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS"])("recovers from denied/unsupported hard links (%s) without replacing files or symlinks", async (code) => {
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("link denied"), { code }));
    await fs.mkdir(downloads);
    const existing = path.join(downloads, "report.txt");
    await fs.writeFile(existing, "existing");
    await fs.symlink(existing, path.join(downloads, "report (1).txt"));
    const source = path.join(root, "source.txt");
    await fs.writeFile(source, "abc");
    const rpc = { request: ({ method, params }: { method: string; params: unknown }) => call(method, params) } as Pick<FederationRpcEndpoint, "request">;
    const result = await pushFederationFile(rpc, source, "report.txt");
    expect(result).toEqual({ path: path.join(downloads, "report (2).txt"), sizeBytes: 3, sha256: digest("abc") });
    expect(await fs.readFile(result.path, "utf8")).toBe("abc");
    expect(await fs.readFile(existing, "utf8")).toBe("existing");
    expect((await fs.lstat(path.join(downloads, "report (1).txt"))).isSymbolicLink()).toBe(true);
    expect((await fs.readdir(downloads)).filter((name) => name.startsWith(".pwragent"))).toEqual([]);
  });

  it("preserves a destination created between link failure and exclusive copy", async () => {
    vi.spyOn(fs, "link").mockImplementationOnce(async (_source, destination) => {
      await fs.writeFile(destination, "concurrent file");
      throw Object.assign(new Error("link denied"), { code: "EPERM" });
    });
    const request = await begin("report.txt", 0);
    const result = await call(methods.finish, { ...request, sha256: digest("") }) as { path: string };
    expect(result.path).toBe(path.join(downloads, "report (1).txt"));
    expect(await fs.readFile(path.join(downloads, "report.txt"), "utf8")).toBe("concurrent file");
    expect(await fs.readFile(result.path, "utf8")).toBe("");
  });

  it("reports both failed finalization operations, cleans staging, and accepts a new transfer", async () => {
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("link denied"), { code: "EPERM" }));
    vi.spyOn(fs, "copyFile").mockRejectedValueOnce(Object.assign(new Error("copy denied"), { code: "EACCES" }));
    const request = await begin("report.txt", 0);
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow(/finalize.*EACCES.*Settings.*Hard-link.*EPERM/);
    expect(await fs.readdir(downloads)).toEqual([]);
    await expect(call(methods.cancel, request)).rejects.toThrow("not found");
    const retry = await begin("report.txt", 0);
    await call(methods.finish, { ...retry, sha256: digest("") });
    expect(await fs.readdir(downloads)).toEqual(["report.txt"]);
  });

  it("does not copy after unrelated link failures or failed verification", async () => {
    const copy = vi.spyOn(fs, "copyFile");
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    const request = await begin("report.txt", 0);
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow("Free disk space");
    const bad = await begin("report.txt", 0);
    await expect(call(methods.finish, { ...bad, sha256: digest("bad") })).rejects.toThrow("checksum");
    expect(copy).not.toHaveBeenCalled();
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("reports a possible partial copy when the OS prevents Node's copy cleanup", async () => {
    vi.spyOn(fs, "link").mockRejectedValue(Object.assign(new Error("link denied"), { code: "EPERM" }));
    vi.spyOn(fs, "copyFile").mockImplementationOnce(async (_source, destination) => {
      // Simulate a failed copy whose native cleanup was also denied.
      await fs.writeFile(destination, "partial", { flag: "wx" });
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const request = await begin("report.txt", 0);
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow(/ENOSPC.*incomplete copy.*not be overwritten/);
    expect(await fs.readdir(downloads)).toEqual(["report.txt"]);
    const retry = await begin("report.txt", 0);
    const result = await call(methods.finish, { ...retry, sha256: digest("") }) as { path: string };
    expect(result.path).toBe(path.join(downloads, "report (1).txt"));
    expect(await fs.readFile(path.join(downloads, "report.txt"), "utf8")).toBe("partial");
  });

  it("reports staging access failures without attributing them to OS privacy", async () => {
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EPERM" }));
    await expect(begin()).rejects.toThrow(/stage.*EPERM.*check the incoming files folder/);
    await expect(fs.stat(downloads)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the original error and identifies staging when cleanup is denied", async () => {
    const request = await begin("report.txt", 0);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("cleanup denied"), { code: "EPERM" }));
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow(/ENOSPC.*staging could not be removed.*pwragent-transfer.*EPERM/);
    // The failed transfer released its slot even when the OS refused cleanup.
    await expect(call(methods.cancel, request)).rejects.toThrow("not found");
    const retry = await begin("report.txt", 0);
    await call(methods.cancel, retry);
  });

  it("identifies a saved file if only staging cleanup fails", async () => {
    const request = await begin("report.txt", 0);
    vi.spyOn(fs, "rm").mockRejectedValueOnce(Object.assign(new Error("cleanup denied"), { code: "EPERM" }));
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow(/was saved to.*report.txt.*cleanup failed.*EPERM/);
    expect(await fs.readFile(path.join(downloads, "report.txt"), "utf8")).toBe("");
    await expect(call(methods.cancel, request)).rejects.toThrow("not found");
  });

  it.each(["../escape", "a/b", "a\\b", "CON.txt", ".hidden", "NUL", "x:", "a\u0000b"])("rejects unsafe filename %s", async (name) => {
    await expect(begin(name)).rejects.toThrow("plain filename");
  });

  it("rejects oversized files and too many live transfers", async () => {
    await expect(begin("big", FILE_PUSH_MAX_BYTES + 1)).rejects.toThrow("512 MiB");
    for (let i = 0; i < 4; i++) await begin();
    await expect(begin()).rejects.toThrow("limit");
  });

  it("binds chunk, finish and cancel to the authenticated originating instance", async () => {
    const request = await begin();
    for (const method of [methods.chunk, methods.finish, methods.cancel]) {
      await expect(call(method, request, "pwr_other")).rejects.toThrow("not found");
    }
    await call(methods.cancel, request);
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("keeps partial files private and removes a failed checksum", async () => {
    const request = await begin();
    await call(methods.chunk, { ...request, offset: 0, dataBase64: Buffer.from("abc").toString("base64") });
    await expect(fs.stat(path.join(downloads, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(call(methods.finish, { ...request, sha256: digest("bad") })).rejects.toThrow("checksum");
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("rejects duplicate or out-of-order chunks and cleans staging", async () => {
    const request = await begin();
    await expect(call(methods.chunk, { ...request, offset: 1, dataBase64: "YWJj" })).rejects.toThrow("offset");
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("rechecks permission before publishing, and allows cancellation after revocation", async () => {
    const request = await begin("empty", 0);
    allowed = false;
    await expect(call(methods.finish, { ...request, sha256: digest("") })).rejects.toThrow("does not allow");
    await call(methods.cancel, request);
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("expires abandoned transfers and removes them on shutdown", async () => {
    vi.useFakeTimers();
    await begin();
    await vi.advanceTimersByTimeAsync(60_001);
    // Wait behind expiry work without starting another transfer.
    await expect(call(methods.cancel, { transferId: "missing" })).rejects.toThrow("not found");
    expect(await fs.readdir(downloads)).toEqual([]);
    await begin();
    await receiver.dispose();
    expect(await fs.readdir(downloads)).toEqual([]);
  });

  it("supports empty files through the sender", async () => {
    const source = path.join(root, "empty.txt");
    await fs.writeFile(source, "");
    const rpc = { request: ({ method, params }: { method: string; params: unknown }) => call(method, params) } as Pick<FederationRpcEndpoint, "request">;
    const result = await pushFederationFile(rpc, source);
    expect(result.sizeBytes).toBe(0);
    expect(await fs.readFile(result.path, "utf8")).toBe("");
  });

  it("waits beyond the default RPC deadline for a slow fallback copy", async () => {
    const router = new FederationRouter({ localInstanceId: "pwr_receiver", methodCapabilities: FILE_PUSH_METHOD_CAPABILITIES });
    registerFilePushHandlers(router, receiver);
    const sentMethods: string[] = [];
    const rpc = new Rpc({ localInstanceId: peer, remoteInstanceId: "pwr_receiver", sendEnvelope: (envelope) => {
      if (envelope.kind === "request") {
        sentMethods.push(envelope.method);
      }
      void router.routeEnvelope({ envelope, sourcePeerId: peer });
    } });
    router.registerConnection({ peerId: peer, capabilities: ["file_push"], sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
    const source = path.join(root, "slow.txt");
    await fs.writeFile(source, "abc");
    let copyStarted!: () => void;
    let releaseCopy!: () => void;
    const started = new Promise<void>((resolve) => { copyStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseCopy = resolve; });
    const copyFile = fs.copyFile.bind(fs);
    vi.spyOn(fs, "link").mockRejectedValueOnce(Object.assign(new Error("link denied"), { code: "EPERM" }));
    vi.spyOn(fs, "copyFile").mockImplementationOnce(async (...args) => {
      copyStarted();
      await release;
      await copyFile(...args);
    });
    vi.useFakeTimers();
    let settled = false;
    const outcome = pushFederationFile(rpc, source).then(
      (result) => { settled = true; return { result }; },
      (error: unknown) => { settled = true; return { error }; },
    );
    try {
      await started;
      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled).toBe(false);
      expect(sentMethods).toEqual([methods.begin, methods.chunk, methods.finish]);
    } finally {
      releaseCopy();
      await outcome;
    }
    expect(await outcome).toEqual({ result: { path: path.join(downloads, "slow.txt"), sizeBytes: 3, sha256: digest("abc") } });
    expect(await fs.readdir(downloads)).toEqual(["slow.txt"]);
    expect(await fs.readFile(path.join(downloads, "slow.txt"), "utf8")).toBe("abc");
  });
});
