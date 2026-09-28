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
});
