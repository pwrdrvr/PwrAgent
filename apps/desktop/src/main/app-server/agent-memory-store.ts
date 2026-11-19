import {
  AGENT_MEMORY_INDEX_BYTES,
  AGENT_MEMORY_NOTE_BYTES,
  AGENT_MEMORY_NOTE_COUNT,
  AGENT_MEMORY_NOTE_ID_PATTERN,
  type AgentMemoryArgs,
  type AgentMemoryResult,
  type AppServerBackendKind,
} from "@pwragent/shared";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfilePath } from "../profile";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";

const memoryFileLocks = new PerKeyAsyncLock();

export function agentMemoryRoot(): string {
  return resolveActiveProfilePath("state/agent-memory");
}

type MemoryOwner = { backend: AppServerBackendKind; threadId: string };
type MemoryDocument = Extract<AgentMemoryResult, { revision: string }>;
const noteIdPattern = new RegExp(AGENT_MEMORY_NOTE_ID_PATTERN, "u");

export class AgentMemoryError extends Error {
  constructor(readonly code: "invalid_arguments" | "forbidden" | "conflict", message: string) {
    super(message);
  }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function parseMemoryArgs(args: unknown): AgentMemoryArgs {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new AgentMemoryError("invalid_arguments", "Provide an Agent memory action.");
  }
  const value = args as Record<string, unknown>;
  const { action, noteId, content, revision } = value;
  const note = action === "read_note" || action === "write_note" || action === "delete_note";
  const write = action === "write_index" || action === "write_note";
  const mutate = write || action === "delete_note";
  const fields = ["action", ...(note ? ["noteId"] : []), ...(write ? ["content"] : []), ...(mutate ? ["revision"] : [])];
  if ((!note && !write && action !== "list" && action !== "read_index")
    || Object.keys(value).some((key) => !fields.includes(key))
    || (note && (typeof noteId !== "string" || !noteIdPattern.test(noteId)))
    || (write && typeof content !== "string")
    || (revision !== undefined && (typeof revision !== "string" || !/^[a-f0-9]{64}$/u.test(revision)))) {
    throw new AgentMemoryError("invalid_arguments", "Provide a valid Agent memory action and its fields. A note ID uses 1–64 lowercase letters, digits, or hyphens and starts with a letter or digit.");
  }
  return value as AgentMemoryArgs;
}

function document(content: string, exists: boolean): MemoryDocument {
  const revision = createHash("sha256").update(exists ? "present\0" : "missing\0").update(content).digest("hex");
  return { content, revision, exists };
}

async function directoryExists(directory: string): Promise<boolean> {
  const entry = await lstat(directory).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!entry) return false;
  if (!entry.isDirectory()) throw new Error("Invalid Agent memory directory.");
  return true;
}

async function readDocument(file: string, limit: number): Promise<MemoryDocument> {
  const entry = await lstat(file).catch((error: unknown) => {
    if (!missing(error)) throw error;
  });
  if (!entry) return document("", false);
  if (!entry.isFile() || entry.nlink !== 1) throw new Error("Invalid Agent memory file.");
  const handle = await open(file, "r");
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.nlink !== 1 || current.ino !== entry.ino || current.dev !== entry.dev) {
      throw new Error("Agent memory file changed while opening.");
    }
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error(`Agent memory file exceeds ${limit} bytes.`);
    return document(bytes.toString("utf8", 0, bytesRead), true);
  } finally {
    await handle.close();
  }
}

async function listNotes(directory: string): Promise<string[]> {
  if (!await directoryExists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const match = entry.isFile() && /^note-(.+)\.md$/u.exec(entry.name);
    return match && noteIdPattern.test(match[1]!) ? [match[1]!] : [];
  }).sort();
}

async function writeDocument(file: string, content: string): Promise<MemoryDocument> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return document(content, true);
}

/** Files belong to the owner profile and the stable PwrAgent thread identity. */
export class AgentMemoryStore {
  constructor(private readonly root = agentMemoryRoot()) {}

  private threadDirectory(owner: MemoryOwner): string {
    const identity = createHash("sha256").update(JSON.stringify([owner.backend, owner.threadId])).digest("hex");
    return path.join(this.root, identity);
  }

  async access(owner: MemoryOwner, input: unknown, authorize: () => Promise<void>): Promise<AgentMemoryResult> {
    const args = parseMemoryArgs(input);
    const directory = this.threadDirectory(owner);
    return await memoryFileLocks.run(directory, async () => {
      await authorize();
      if (await directoryExists(this.root)) await directoryExists(directory);
      const notes = path.join(directory, "notes");
      if (args.action === "list") return { noteIds: await listNotes(notes) };
      const noteId = "noteId" in args ? args.noteId : undefined;
      if (noteId) await directoryExists(notes);
      const file = noteId ? path.join(notes, `note-${noteId}.md`) : path.join(directory, "index.md");
      const limit = noteId ? AGENT_MEMORY_NOTE_BYTES : AGENT_MEMORY_INDEX_BYTES;
      if ("content" in args && Buffer.byteLength(args.content, "utf8") > limit) {
        throw new AgentMemoryError("invalid_arguments", `This file can hold up to ${limit} UTF-8 bytes. Shorten the text or move detail into another note.`);
      }
      const current = await readDocument(file, limit);
      if ("revision" in args && args.revision !== undefined && args.revision !== current.revision) {
        throw new AgentMemoryError("conflict", "Agent memory changed. Reload this file before saving.");
      }
      if (args.action === "delete_note") {
        await rm(file, { force: true });
        return document("", false);
      }
      if (!("content" in args)) return current;
      if (noteId && !current.exists && (await listNotes(notes)).length >= AGENT_MEMORY_NOTE_COUNT) {
        throw new AgentMemoryError("invalid_arguments", `This Agent can keep up to ${AGENT_MEMORY_NOTE_COUNT} notes. Delete a note before adding another.`);
      }
      if (current.exists && current.content === args.content) return current;
      return await writeDocument(file, args.content);
    });
  }

  async purge(owner: MemoryOwner): Promise<void> {
    const directory = this.threadDirectory(owner);
    await memoryFileLocks.run(directory, async () => {
      if (await directoryExists(this.root)) await rm(directory, { recursive: true, force: true });
    });
  }
}
