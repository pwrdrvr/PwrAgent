import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { FederationFilePullReader, FILE_PULL_MAX_BYTES, FILE_PULL_MARKDOWN_METHOD, resolveFilePullThread } from "../federation/federation-file-pull";

import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

describe("Federation file pull", () => {
  let root: string;
  let directory: string;
  let reader: FederationFilePullReader;
  let permissions: { filePull: boolean; filePullOutsideThreadDirectories: boolean };
  let thread: AppServerThreadSummary | undefined;
  const identity = { backend: "codex", threadId: "owner-thread" };
  const resolveThread = vi.fn(async () => thread);
  const pull = (filePath: string) => reader.readMarkdown({ path: filePath, thread: identity });

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-file-pull-")));
    directory = path.join(root, "project");
    await mkdir(directory);
    await writeFile(path.join(directory, "report.md"), "# Owner report\n");
    permissions = { filePull: true, filePullOutsideThreadDirectories: false };
    thread = { id: "owner-thread", source: "codex", linkedDirectories: [], projectKey: directory } as unknown as AppServerThreadSummary;
    resolveThread.mockClear();
    reader = new FederationFilePullReader({ permissions: () => permissions, resolveThread });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("reads an owner-resolved thread file without writing a copy", async () => {
    expect(await pull(path.join(directory, "report.md"))).toEqual({ path: path.join(directory, "report.md"), content: "# Owner report\n" });
    expect(resolveThread).toHaveBeenCalledWith("codex", "owner-thread");
  });

  it("continues authorized previews after the owning thread is archived", async () => {
    const registry = {
      resolveThread: vi.fn(async () => thread),
      listThreads: vi.fn(async () => [thread!]),
    };
    reader = new FederationFilePullReader({
      permissions: () => permissions,
      resolveThread: (backend, threadId) => resolveFilePullThread(registry, backend, threadId),
    });
    const filePath = path.join(directory, "report.md");
    expect((await pull(filePath)).content).toContain("Owner report");
    expect(registry.resolveThread).toHaveBeenCalledWith(identity);
    expect(registry.listThreads).not.toHaveBeenCalled();

    thread!.archivedAt = Date.now();
    registry.resolveThread.mockResolvedValue(undefined);
    expect((await pull(filePath)).content).toContain("Owner report");
    expect(registry.listThreads).toHaveBeenCalledWith({
      backend: "codex",
      archived: true,
      forceRefresh: true,
      enrichDirectories: false,
      callerReason: "federation-file-pull",
    });

    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside");
    await expect(pull(outside)).rejects.toThrow("outside the thread");
    permissions.filePull = false;
    await expect(pull(filePath)).rejects.toThrow("File pull is disabled");
  });

  it("rejects archived threads with a different identity and truly missing threads", async () => {
    const registry = {
      resolveThread: vi.fn(async () => undefined),
      listThreads: vi.fn(async () => [{ ...thread!, id: "different-thread" }]),
    };
    reader = new FederationFilePullReader({
      permissions: () => permissions,
      resolveThread: (backend, threadId) => resolveFilePullThread(registry, backend, threadId),
    });
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("thread was not found");
    registry.listThreads.mockResolvedValue([]);
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("thread was not found");
  });

  it("reads through an authenticated gateway relay and enforces owner permissions", async () => {
    const methodCapabilities = { [FILE_PULL_MARKDOWN_METHOD]: "file_pull" as const };
    const owner = new FederationRouter({ localInstanceId: "pwr_owner", trustedRelayPeerId: "pwr_gateway", methodCapabilities });
    owner.registerHandler(FILE_PULL_MARKDOWN_METHOD, (envelope) => reader.readMarkdown(envelope.params));
    const gateway = new FederationRouter({ localInstanceId: "pwr_gateway", methodCapabilities });
    const rpc = new FederationRpcEndpoint({ localInstanceId: "pwr_viewer", remoteInstanceId: "pwr_owner", sendEnvelope: (envelope) => { void gateway.routeEnvelope({ envelope, sourcePeerId: "pwr_viewer" }); } });
    owner.registerConnection({ peerId: "pwr_gateway", capabilities: ["file_pull", "gateway_relay"], sendEnvelope: (envelope) => { void gateway.routeEnvelope({ envelope, sourcePeerId: "pwr_owner" }); } });
    gateway.registerConnection({ peerId: "pwr_viewer", capabilities: ["file_pull", "gateway_relay"], sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
    gateway.registerConnection({ peerId: "pwr_owner", capabilities: ["file_pull", "gateway_relay"], sendEnvelope: (envelope) => { void owner.routeEnvelope({ envelope, sourcePeerId: "pwr_gateway" }); } });
    const request = { method: FILE_PULL_MARKDOWN_METHOD, params: { path: path.join(directory, "report.md"), thread: identity } };
    expect(await rpc.request(request)).toMatchObject({ content: "# Owner report\n" });
    permissions.filePull = false;
    await expect(rpc.request(request)).rejects.toThrow("File pull is disabled");
  });

  it("denies disabled pulls before resolving paths or threads", async () => {
    permissions.filePull = false;
    permissions.filePullOutsideThreadDirectories = true;
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("File pull is disabled");
    expect(resolveThread).not.toHaveBeenCalled();
  });

  it("rejects outside paths, traversal, sibling prefixes, and symlink escapes", async () => {
    const outside = path.join(root, "project-other", "secret.md");
    await mkdir(path.dirname(outside));
    await writeFile(outside, "secret");
    await symlink(outside, path.join(directory, "link.md"));
    await symlink(path.dirname(outside), path.join(directory, "escape"), "dir");
    for (const target of [outside, `${directory}/../project-other/secret.md`, path.join(directory, "link.md"), path.join(directory, "escape", "secret.md")]) {
      await expect(pull(target)).rejects.toThrow("outside the thread");
    }
    permissions.filePullOutsideThreadDirectories = true;
    expect((await pull(outside)).content).toBe("secret");
  });

  it("supports attached directories and worktrees from owner state", async () => {
    const linked = path.join(root, "linked");
    await mkdir(linked);
    await writeFile(path.join(linked, "linked.md"), "linked");
    thread!.linkedDirectories = [{ path: linked, worktreePath: directory }] as AppServerThreadSummary["linkedDirectories"];
    thread!.projectKey = undefined;
    expect((await pull(path.join(linked, "linked.md"))).content).toBe("linked");
    expect((await pull(path.join(directory, "report.md"))).content).toContain("Owner report");
  });

  it("requires a valid owner thread even with outside access enabled", async () => {
    permissions.filePullOutsideThreadDirectories = true;
    await expect(reader.readMarkdown({ path: path.join(directory, "report.md") })).rejects.toThrow("owning thread");
    thread = undefined;
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("thread was not found");
  });

  it("denies files when a thread has no trusted directories", async () => {
    thread!.projectKey = undefined;
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("outside the thread");
  });

  it("rejects directories, non-Markdown paths and oversized files", async () => {
    await mkdir(path.join(directory, "folder.md"));
    await expect(pull(path.join(directory, "folder.md"))).rejects.toThrow("regular file");
    await expect(pull(path.join(directory, "plain.txt"))).rejects.toThrow("Markdown file path");
    await writeFile(path.join(directory, "large.md"), Buffer.alloc(FILE_PULL_MAX_BYTES + 1));
    await expect(pull(path.join(directory, "large.md"))).rejects.toThrow("too large");
  });

  it("rechecks permissions after asynchronous owner lookup", async () => {
    resolveThread.mockImplementationOnce(async () => { permissions.filePull = false; return thread; });
    await expect(pull(path.join(directory, "report.md"))).rejects.toThrow("permissions changed");
  });
});
