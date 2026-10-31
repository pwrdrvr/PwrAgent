import { createHash } from "node:crypto";
import { appendFile, copyFile, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadActivityEntry, AppServerThreadEntry, AppServerThreadImagePart } from "@pwragent/shared";
import { ClaudeSessionStore } from "../claude/claude-session-store";
import { claudeToolResultContent } from "../claude/claude-tool-activity";
import { materializeTranscriptImageUrlsForRenderer, toTranscriptImageProtocolUrl } from "../transcript-image-protocol";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, link: vi.fn(actual.link), copyFile: vi.fn(actual.copyFile), rename: vi.fn(actual.rename) };
});

const id = "e3333333-3333-4333-8333-333333333333";
const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-images-"));
  roots.push(root);
  const sessions = path.join(root, "claude");
  const images = path.join(root, "thread-images", "claude");
  return { root, sessions, images, history: path.join(sessions, `${id}.jsonl`), store: new ClaudeSessionStore(sessions, images) };
}

function activity(bytes = png): AppServerThreadActivityEntry {
  const { images } = claudeToolResultContent([
    { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } },
  ], "Read shot.png");
  return {
    type: "activity", id: "read-1", summary: "Read shot.png", status: "completed",
    details: [{ id: "read-1:output", kind: "read", label: "Read shot.png output", images }],
  };
}

function imagePath(image: AppServerThreadImagePart): string {
  return fileURLToPath(decodeURIComponent(image.url.slice("pwragent-image://file/".length)));
}

function entryImages(entries: AppServerThreadEntry[]): AppServerThreadImagePart[] {
  return entries.flatMap((entry) => entry.type === "activity"
    ? entry.details.flatMap((detail) => detail.images ?? [])
    : entry.type === "message" ? entry.parts?.filter((part) => part.type === "image") ?? [] : []);
}

afterEach(async () => {
  vi.mocked(link).mockReset();
  vi.mocked(copyFile).mockReset();
  vi.mocked(rename).mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude history image persistence", () => {
  it("retains tool and user images once across revisions and restarts without changing live entries", async () => {
    const f = await fixture();
    const tool = activity();
    const user: AppServerThreadEntry = {
      type: "message", id: "user-1", role: "user", text: "Look",
      parts: [{ type: "text", text: "Look" }, { type: "image", url: `data:image/png;base64,${png.toString("base64")}`, alt: "Input" }],
    };
    const originals = JSON.stringify([user, tool]);
    await f.store.append(id, [user, tool]);
    const saved = await f.store.entries(id);
    const savedImages = entryImages(saved);
    expect(savedImages).toHaveLength(2);
    expect(savedImages[0]?.url).toBe(savedImages[1]?.url);
    const retainedPath = imagePath(savedImages[0]!);
    expect(retainedPath).toBe(path.join(f.images, id, `${createHash("sha256").update(png).digest("hex")}.png`));
    await expect(readFile(retainedPath)).resolves.toEqual(png);
    expect(savedImages.map((image) => image.alt)).toEqual(["Input", "Read shot.png"]);

    const oldTime = new Date("2020-01-01T00:00:00Z");
    await utimes(retainedPath, oldTime, oldTime);
    await f.store.append(id, [user, tool]); // turn-end revisions
    const restarted = new ClaudeSessionStore(f.sessions, f.images);
    await restarted.append(id, [{ ...tool, summary: "Background task settled" }]);
    expect((await stat(retainedPath)).mtimeMs).toBe(oldTime.getTime());
    expect(await readdir(path.join(f.images, id))).toHaveLength(1);
    expect(await restarted.entries(id)).toEqual([saved[0], { ...saved[1], summary: "Background task settled" }]);
    expect(JSON.stringify([user, tool])).toBe(originals);
    expect(await readFile(f.history, "utf8")).not.toContain("data:image/");
  });

  it("reuses the renderer cache and leaves legacy inline history readable and unchanged", async () => {
    const f = await fixture();
    const tool = activity();
    await mkdir(f.sessions);
    const legacy = JSON.stringify(tool) + "\n";
    await writeFile(f.history, legacy);
    expect(await f.store.entries(id)).toEqual([tool]);
    const response = await materializeTranscriptImageUrlsForRenderer({
      backend: "claude", threadId: id, fetchedAt: 0,
      replay: { entries: [tool], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
    }, { resolveRoot: () => path.join(f.images, id) });
    const cachedImage = entryImages(response.replay.entries)[0]!;
    const oldTime = new Date("2020-01-01T00:00:00Z");
    await utimes(imagePath(cachedImage), oldTime, oldTime);
    await f.store.append(id, [tool]);
    expect(entryImages(await f.store.entries(id))[0]).toEqual(cachedImage);
    expect((await stat(imagePath(cachedImage))).mtimeMs).toBe(oldTime.getTime());
    expect((await readFile(f.history, "utf8")).startsWith(legacy)).toBe(true);
    // Old and new revisions still participate in append-only rewind/undo.
    const truncation = await f.store.truncate(id, tool.id);
    expect(await f.store.entries(id)).toEqual([]);
    await f.store.undoTruncation(id, truncation);
    expect(entryImages(await f.store.entries(id))[0]).toEqual(cachedImage);
  });

  it("does not append a dangling URL when the image directory cannot be written", async () => {
    const f = await fixture();
    await mkdir(path.dirname(f.images));
    await writeFile(f.images, "blocks directory creation");
    await expect(f.store.append(id, [activity()])).rejects.toThrow();
    await expect(readFile(f.history)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(f.images);
    await f.store.append(id, [activity()]);
    await expect(readFile(imagePath(entryImages(await f.store.entries(id))[0]!))).resolves.toEqual(png);
  });

  it("keeps a fork's cached images after the source thread's image directory is removed", async () => {
    const f = await fixture();
    const forkId = "f3333333-3333-4333-8333-333333333333";
    await f.store.append(id, [activity()]);
    await f.store.append(forkId, await f.store.entries(id));
    await rm(path.join(f.images, id), { recursive: true });
    const forkPath = imagePath(entryImages(await f.store.entries(forkId))[0]!);
    expect(path.dirname(forkPath)).toBe(path.join(f.images, forkId));
    await expect(readFile(forkPath)).resolves.toEqual(png);
  });

  it.each(["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EMLINK"])(
    "persists user/tool images and retains forks when hard links fail with %s", async (code) => {
      const f = await fixture();
      vi.mocked(link).mockRejectedValue(Object.assign(new Error("No hard links"), { code }));
      const forkId = "f3333333-3333-4333-8333-333333333333";
      const user: AppServerThreadEntry = {
        type: "message", id: "user-1", role: "user", text: "Look",
        parts: [{ type: "image", url: `data:image/png;base64,${png.toString("base64")}` }],
      };
      await f.store.append(id, [user, activity()]);
      expect(link).not.toHaveBeenCalled();
      const source = await f.store.entries(id);
      await expect(readFile(imagePath(entryImages(source)[0]!))).resolves.toEqual(png);
      await f.store.append(forkId, source);
      expect(link).toHaveBeenCalled();
      expect(copyFile).toHaveBeenCalledTimes(1);
      await rm(path.join(f.images, id), { recursive: true });
      const forkImages = entryImages(await f.store.entries(forkId));
      expect(forkImages).toHaveLength(2);
      for (const image of forkImages) {
        expect(path.dirname(imagePath(image))).toBe(path.join(f.images, forkId));
        await expect(readFile(imagePath(image))).resolves.toEqual(png);
      }
      expect(await readdir(path.join(f.images, forkId))).toHaveLength(1);
      expect(await readFile(path.join(f.sessions, `${forkId}.jsonl`), "utf8")).not.toContain("data:image/");
    },
  );

  it("propagates unexpected fork-link errors without appending history", async () => {
    const f = await fixture();
    const forkId = "f3333333-3333-4333-8333-333333333333";
    await f.store.append(id, [activity()]);
    vi.mocked(link).mockRejectedValue(Object.assign(new Error("I/O error"), { code: "EIO" }));
    await expect(f.store.append(forkId, await f.store.entries(id))).rejects.toMatchObject({ code: "EIO" });
    expect(copyFile).not.toHaveBeenCalled();
    await expect(readFile(path.join(f.sessions, `${forkId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes an incomplete fork copy when fallback copying fails", async () => {
    const f = await fixture();
    const forkId = "f3333333-3333-4333-8333-333333333333";
    await f.store.append(id, [activity()]);
    vi.mocked(link).mockRejectedValue(Object.assign(new Error("No hard links"), { code: "ENOTSUP" }));
    vi.mocked(copyFile).mockImplementationOnce(async (_source, destination) => {
      await writeFile(destination, "partial copy");
      throw Object.assign(new Error("Disk full"), { code: "ENOSPC" });
    });
    await expect(f.store.append(forkId, await f.store.entries(id))).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await readdir(path.join(f.images, forkId))).toEqual([]);
    await expect(readFile(path.join(f.sessions, `${forkId}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a truncated legacy cache file and publishes complete images during concurrent appends", async () => {
    const f = await fixture();
    const root = path.join(f.images, id);
    const cached = path.join(root, `${createHash("sha256").update(png).digest("hex")}.png`);
    await mkdir(root, { recursive: true });
    await writeFile(cached, png.subarray(0, 8));
    await Promise.all([f.store.append(id, [activity()]), f.store.append(id, [activity()])]);
    await expect(readFile(cached)).resolves.toEqual(png);
    expect(rename).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([path.basename(cached)]);
    expect(await f.store.entries(id)).toHaveLength(1);
  });

  it.each(["EPERM", "EACCES", "EEXIST"])("reuses a complete concurrent publisher after rename fails with %s", async (code) => {
    const f = await fixture();
    vi.mocked(rename).mockImplementationOnce(async (_temporary, destination) => {
      await writeFile(destination, png);
      throw Object.assign(new Error("Concurrent publication"), { code });
    });
    await f.store.append(id, [activity()]);
    const [image] = entryImages(await f.store.entries(id));
    await expect(readFile(imagePath(image!))).resolves.toEqual(png);
    expect(await readdir(path.join(f.images, id))).toEqual([path.basename(imagePath(image!))]);
  });

  it.each(["missing", "truncated", "different", "unexpected"])("preserves publication failures for %s output and allows a later write", async (output) => {
    const f = await fixture();
    const failure = Object.assign(new Error("Publication failed"), { code: output === "unexpected" ? "EIO" : "EPERM" });
    vi.mocked(rename).mockImplementationOnce(async (_temporary, destination) => {
      if (output !== "missing") await writeFile(destination,
        output === "truncated" ? png.subarray(0, 8) : output === "different" ? Buffer.alloc(png.length) : png);
      throw failure;
    });
    await expect(f.store.append(id, [activity()])).rejects.toBe(failure);
    await expect(readFile(f.history)).rejects.toMatchObject({ code: "ENOENT" });
    const root = path.join(f.images, id);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    // A failed publication must not leave a rejected promise cached forever.
    await rm(root, { recursive: true });
    await f.store.append(id, [activity()]);
    const [image] = entryImages(await f.store.entries(id));
    await expect(readFile(imagePath(image!))).resolves.toEqual(png);
  });

  it("preserves remote and existing file URLs, malformed images, and text", async () => {
    const f = await fixture();
    const entry: AppServerThreadEntry = {
      type: "message", id: "user-1", role: "user", text: "data:image/png;base64,AQID",
      parts: [
        { type: "text", text: "data:image/png;base64,AQID" },
        ...["https://example.test/image.png", "file:///tmp/input.png", toTranscriptImageProtocolUrl("file:///tmp/input.png"),
          "data:image/png;base64,!!!!", "data:image/heic;base64,AQID"].map((url) => ({ type: "image" as const, url })),
      ],
    };
    await f.store.append(id, [entry]);
    expect(await f.store.entries(id)).toEqual([entry]);
    await expect(readdir(f.images)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps ephemeral image entries and late writes off disk", async () => {
    const f = await fixture();
    f.store.holdEphemeral({ cwd: "/fixture", ephemeral: true, thread: {
      id, source: "claude", title: "Monitor", titleSource: "explicit", linkedDirectories: [],
    } });
    await f.store.append(id, [activity()]);
    expect(await f.store.entries(id)).toEqual([activity()]);
    f.store.forgetEphemeral(id);
    await f.store.append(id, [activity()]);
    expect(await readdir(f.root)).toEqual([]);
  });

  it("externalizes user image inputs with line-wrapped base64 accepted by the Claude SDK", async () => {
    const f = await fixture();
    const data = png.toString("base64");
    await f.store.append(id, [{ type: "message", id: "user-1", role: "user", text: "Look", parts: [
      { type: "image", url: `data:image/png;base64,${data.slice(0, 40)}\n${data.slice(40)}\n` },
    ] }]);
    await expect(readFile(imagePath(entryImages(await f.store.entries(id))[0]!))).resolves.toEqual(png);
    expect(await readFile(f.history, "utf8")).not.toContain("data:image/");
  });

  it("measures JSONL for one Read of a 2 MiB PNG at completion, turn end, and background settlement", async () => {
    const f = await fixture();
    // Insert a CRC-valid ancillary text chunk before IEND to make an exact 2 MiB PNG.
    const padding = Buffer.alloc(2 * 1024 * 1024 - png.length - 12, 65);
    padding.write("Comment\0");
    const chunk = Buffer.alloc(padding.length + 12);
    chunk.writeUInt32BE(padding.length);
    chunk.write("tEXt", 4);
    padding.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const largePng = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    expect(largePng.length).toBe(2 * 1024 * 1024);
    const tool = activity(largePng);
    const baseline = path.join(f.root, "before.jsonl");
    const measurements: Array<{ revisions: number; beforeBytes: number; afterBytes: number }> = [];
    for (let revision = 1; revision <= 3; revision += 1) {
      // This is the previous append implementation, with the identical tool entry.
      await appendFile(baseline, JSON.stringify(tool) + "\n");
      await f.store.append(id, [tool]);
      measurements.push({ revisions: revision, beforeBytes: (await stat(baseline)).size, afterBytes: (await stat(f.history)).size });
    }
    const retainedPath = imagePath(entryImages(await f.store.entries(id))[0]!);
    expect((await stat(retainedPath)).size).toBe(largePng.length);
    expect(await readdir(path.dirname(retainedPath))).toHaveLength(1);
    expect(measurements[2]!.afterBytes).toBeLessThan(4096);
    expect(measurements[2]!.beforeBytes).toBeGreaterThan(8 * 1024 * 1024);
    console.log("Claude Read image JSONL bytes:", JSON.stringify({ imageBytes: largePng.length, measurements }));
  });
});
