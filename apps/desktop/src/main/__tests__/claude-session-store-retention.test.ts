import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore, type ClaudeSession } from "../claude/claude-session-store";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const id = "c3333333-3333-4333-8333-333333333333";
const otherId = "d3333333-3333-4333-8333-333333333333";
const roots: string[] = [];
const backends: ClaudeBackend[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-store-retention-"));
  roots.push(root);
  const store = new ClaudeSessionStore(root);
  const backend = new ClaudeBackend({ store, emit: vi.fn(), request: vi.fn(), cancelRequest: vi.fn(),
    inspectInstallation: async () => ({ authStatus: "unknown" }) });
  backends.push(backend);
  const session: ClaudeSession = { cwd: "/fixture/.pwragent/worktrees/retention/repo", thread: {
    id, source: "claude", title: "Archive", titleSource: "explicit", linkedDirectories: [], archivedAt: 1,
  } };
  await store.save(session);
  return { root, store, backend, session };
}

afterEach(async () => {
  vi.mocked(rm).mockReset();
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Claude retention storage safeguards", () => {
  it("fails complete discovery on unreadable metadata while ordinary navigation still lists readable threads", async () => {
    const { root, store, backend } = await fixture();
    await writeFile(path.join(root, `${otherId}.json`), "invalid metadata");
    expect((await backend.listThreads({ archived: true })).map((thread) => thread.id)).toEqual([id]);
    await expect(backend.listThreads({ archived: true, requireComplete: true })).rejects.toThrow();
    await expect(store.read(id)).resolves.toBeDefined();
  });

  it.each(["invalid", "directory", "present", "absent"])("confirms only an absent metadata file, retaining recovery state on %s", async (state) => {
    const { root, backend } = await fixture();
    const metadata = path.join(root, `${id}.json`);
    if (state === "invalid") await writeFile(metadata, "invalid metadata");
    if (state === "directory" || state === "absent") await rm(metadata);
    if (state === "directory") await mkdir(metadata);
    const confirmation = backend.confirmThreadAbsent(id);
    if (state === "invalid" || state === "directory") await expect(confirmation).rejects.toThrow();
    else await expect(confirmation).resolves.toBe(state === "absent");
  });

  it("leaves metadata and recovery refs discoverable after partial file deletion, then retries", async () => {
    const { root, store, backend } = await fixture();
    await store.append(id, [{ type: "message", id: "message", role: "user", text: "Fixture" }]);
    const backup = store.rewindBackupDirectory(id);
    await mkdir(backup, { recursive: true });
    const actualRm = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(rm).mockImplementationOnce(actualRm.rm).mockRejectedValueOnce(new Error("Fixture backup unavailable"));
    await expect(backend.deleteThread(id)).rejects.toThrow("Fixture backup unavailable");
    await expect(stat(path.join(root, `${id}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.read(id)).resolves.toBeDefined();
    await backend.deleteThread(id);
    await expect(stat(path.join(root, `${id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps another thread and SDK history paths untouched", async () => {
    const { root, store, backend, session } = await fixture();
    const sdkDirectory = path.join(root, "provider-history");
    await mkdir(sdkDirectory);
    const sdkHistory = path.join(sdkDirectory, `${id}.jsonl`);
    await writeFile(sdkHistory, "provider-owned fixture");
    await store.save({ ...session, sdkSessionId: id, sdkSessionDir: sdkDirectory });
    await store.save({ ...session, thread: { ...session.thread, id: otherId } });
    await backend.deleteThread(id);
    await expect(readFile(sdkHistory, "utf8")).resolves.toBe("provider-owned fixture");
    await expect(store.read(otherId)).resolves.toBeDefined();
  });

  it("refuses permanent deletion of a restored thread and invalid thread ids", async () => {
    const { store, backend, session } = await fixture();
    await store.save({ ...session, thread: { ...session.thread, archivedAt: undefined } });
    await expect(backend.deleteThread(id)).rejects.toThrow("Archive this Claude thread");
    await expect(store.delete("../outside")).rejects.toThrow("Invalid Claude thread id");
    await expect(store.read(id)).resolves.toBeDefined();
  });
});
