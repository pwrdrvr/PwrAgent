import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { MessagingOriginalAttachmentStore, ORIGINAL_ATTACHMENT_RETENTION_MS } from "../messaging/core/messaging-original-attachment-store";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pwragent-original-"));
  directories.push(directory);
  return directory;
}
const scope = { backend: "codex", threadId: "thread-1" };
const actorKey = MessagingOriginalAttachmentStore.actorKey("conversation", "user-1");
const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

describe("original attachment storage", () => {
  it("matches a FIFO model at both the record and original-byte limits", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.uint8Array({ minLength: 1, maxLength: 20 }), { minLength: 8, maxLength: 12 }),
      async (downloads) => {
        const root = await temporary();
        let now = 1000;
        const store = new MessagingOriginalAttachmentStore(root, () => now++, { maxRecords: 3, maxOriginalBytes: 25 });
        const model: { attachmentId: string; sizeBytes: number }[] = [];
        for (const [index, data] of downloads.entries()) {
          const retained = await store.retain({ data, name: "file", scope, actorKey,
            eventId: String(index), attachmentKey: "file" });
          model.push(retained);
          while (model.length > 3 || model.reduce((sum, item) => sum + item.sizeBytes, 0) > 25) model.shift();
          expect(new Set((await store.list(scope)).attachments.map((item) => item.attachmentId)))
            .toEqual(new Set(model.map((item) => item.attachmentId)));
          expect((await readdir(root)).length).toBe(model.length);
        }
        await rm(root, { recursive: true, force: true });
      },
    ), { numRuns: 6 });
  });
  it("round-trips arbitrary original bytes across restart, export and a sandbox-owned no-clobber save", async () => {
    await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 1024 }), fc.string({ maxLength: 80 }), async (data, name) => {
      const root = await temporary();
      const cache = path.join(root, "cache");
      const store = new MessagingOriginalAttachmentStore(cache);
      const input = { data, name: `../../${name}/report.pdf`, mimeType: "application/pdf", scope,
        actorKey, eventId: "event-1", attachmentKey: "secret-provider-file-id" };
      const retained = await store.retain(input);
      expect(retained.sha256).toBe(hash(data));
      expect(await store.retain(input)).toEqual(retained);
      expect((await readdir(cache)).length).toBe(1);
      const restarted = new MessagingOriginalAttachmentStore(cache);
      expect((await restarted.list(scope, actorKey)).attachments).toEqual([retained]);
      const exported = await restarted.export(scope, retained.attachmentId, actorKey);
      expect(path.relative(cache, exported.path)).toBe(path.join(retained.attachmentId, "export"));
      const saved = path.join(root, "user-chosen.pdf");
      await copyFile(exported.path, saved, constants.COPYFILE_EXCL);
      expect(hash(await readFile(saved))).toBe(hash(data));
      await expect(copyFile(exported.path, saved, constants.COPYFILE_EXCL)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path.join(cache, retained.attachmentId, "original"))).toEqual(Buffer.from(data));
      expect((await restarted.export(scope, retained.attachmentId, actorKey)).path).toBe(exported.path);
      await expect(restarted.export({ ...scope, threadId: "other-thread" }, retained.attachmentId, actorKey)).rejects.toMatchObject({ code: "not_found" });
      await expect(restarted.export(scope, retained.attachmentId, "other-actor")).rejects.toMatchObject({ code: "not_found" });
      await expect(restarted.export({ ...scope, instanceId: "other-owner" }, retained.attachmentId, actorKey)).rejects.toMatchObject({ code: "not_found" });
      await rm(root, { recursive: true, force: true });
    }), { numRuns: 12 });
  });

  it.each(["symlink", "hardlink", "modified"])("refuses a %s export without changing the original or unrelated destination", async (kind) => {
    const root = await temporary();
    const store = new MessagingOriginalAttachmentStore(path.join(root, "cache"));
    const data = Buffer.from("%PDF-1.7\noriginal\n");
    const retained = await store.retain({ data, name: "../../victim", scope, actorKey, eventId: "event", attachmentKey: "file" });
    const exportPath = path.join(root, "cache", retained.attachmentId, "export");
    const victim = path.join(root, "victim");
    await writeFile(victim, "unrelated");
    if (kind === "symlink") await symlink(victim, exportPath);
    if (kind === "hardlink") await link(victim, exportPath);
    if (kind === "modified") await writeFile(exportPath, "modified");
    await expect(store.export(scope, retained.attachmentId)).rejects.toMatchObject({ code: "forbidden",
      message: expect.stringContaining("original is retained") });
    expect(await readFile(victim, "utf8")).toBe("unrelated");
    expect(await readFile(path.join(root, "cache", retained.attachmentId, "original"))).toEqual(data);
  });

  it("lists multiple same-name files with pagination, stable IDs, and expiry after restart", async () => {
    const root = await temporary();
    let now = 1000;
    const store = new MessagingOriginalAttachmentStore(root, () => now);
    const expected = new Set<string>();
    for (let index = 0; index < 27; index += 1) {
      expected.add((await store.retain({ data: Buffer.from([index]), name: "same.pdf", scope, actorKey,
        eventId: `event-${index}`, attachmentKey: "file" })).attachmentId);
    }
    const first = await store.list(scope, actorKey);
    expect(first.attachments).toHaveLength(25);
    const second = await store.list(scope, actorKey, first.nextCursor);
    expect(second.attachments).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.attachments, ...second.attachments].map((item) => item.attachmentId))).toEqual(expected);
    now += ORIGINAL_ATTACHMENT_RETENTION_MS;
    const restarted = new MessagingOriginalAttachmentStore(root, () => now);
    expect((await restarted.list(scope)).attachments).toEqual([]);
    await expect(restarted.export(scope, [...expected][0]!)).rejects.toMatchObject({ code: "not_found" });
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses arbitrary source paths, missing originals and oversize files", async () => {
    const root = await temporary();
    const store = new MessagingOriginalAttachmentStore(root);
    await expect(store.export(scope, "../../victim")).rejects.toMatchObject({ code: "not_found" });
    await expect(store.retain({ data: Buffer.alloc(10 * 1024 * 1024 + 1), name: "huge", scope, actorKey,
      eventId: "huge", attachmentKey: "file" })).rejects.toMatchObject({ code: "invalid_arguments" });
    const retained = await store.retain({ data: Buffer.from("hello"), name: "file.txt", scope, actorKey,
      eventId: "small", attachmentKey: "file" });
    await rm(path.join(root, retained.attachmentId, "original"));
    await expect(store.export(scope, retained.attachmentId)).rejects.toMatchObject({ code: "not_found" });
    // A symlink at the cache root grants no authority either.
    const parent = await temporary();
    await mkdir(path.join(parent, "elsewhere"));
    await symlink(path.join(parent, "elsewhere"), path.join(parent, "cache"), "dir");
    await expect(new MessagingOriginalAttachmentStore(path.join(parent, "cache")).list(scope)).rejects.toMatchObject({ code: "not_found" });
  });
});
