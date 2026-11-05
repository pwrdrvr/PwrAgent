import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { createGitHandoffService, type HandoffGitRunner } from "@pwragent/federation/git-instance-handoff";
import { ThreadInstanceHandoffService } from "@pwragent/federation/thread-instance-handoff-service";
import { CodexAppServerClient } from "../src/main/codex-app-server/client";
import { createProviderRuntimeClient } from "../src/main/codex-app-server/provider-runtime-client";

vi.mock("../src/main/log", () => ({
  getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const command = process.env.PWRAGENT_CODEX_HANDOFF_ORACLE_COMMAND;
if (!command || !path.isAbsolute(command)) {
  throw new Error("Set PWRAGENT_CODEX_HANDOFF_ORACLE_COMMAND to the absolute Codex binary to test.");
}
const execute = promisify(execFile);
const runGitCommand: HandoffGitRunner = async (cwd, args, options) =>
  await execute("git", ["-C", cwd, ...args], { ...options, encoding: "utf8" });
const roots: string[] = [];
const clients: CodexAppServerClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-oracle-"));
  roots.push(root);
  const sourceCwd = path.join(root, "source-workspace");
  await mkdir(sourceCwd);
  const createClient = async (name: string) => {
    const codexHome = path.join(root, name);
    await mkdir(codexHome);
    const client = new CodexAppServerClient({
      command, authenticationRecovery: false,
      env: { ...process.env, CODEX_HOME: codexHome }, directoryResolver: async () => [],
    });
    clients.push(client);
    return client;
  };
  const sourceClient = await createClient("sender-codex");
  const targetClient = await createClient("receiver-codex");
  const target = createProviderRuntimeClient(targetClient, {
    resolveProviders: () => [], create: () => { throw new Error("Unexpected provider runtime"); },
  });
  const sourceLookup = vi.spyOn(targetClient, "readThreadSummary");
  const makeBackend = (client: CodexAppServerClient) => ({
    withThreadHandoff: async <T>(_id: string, work: () => Promise<T>) => await work(),
    exportThreadForHandoff: (id: string) => client.exportThreadForHandoff(id),
    forkThread: async (request: { sourceThreadId: string; sourceThreadPath: string; directoryPath: string }) =>
      await client.forkThread({ threadId: request.sourceThreadId, path: request.sourceThreadPath, cwd: request.directoryPath }),
    readThread: async ({ threadId }: { threadId: string }) => ({ replay: await client.readThread({ threadId }) }),
    archiveThread: async ({ threadId }: { threadId: string }) => await client.archiveThread({ threadId }),
    renameThread: async ({ threadId, name }: { threadId: string; name: string }) => await client.renameThread({ threadId, name }),
  });
  const common = {
    git: createGitHandoffService(runGitCommand), runGitCommand,
    allocateWorktree: async () => path.join(root, "imported-worktree"),
    releaseWorktree: async () => {}, assertTarget: () => {}, receipt: () => true,
  };
  const receiver = new ThreadInstanceHandoffService({
    ...common, backend: makeBackend(target), directory: path.join(root, "receiver"), localInstanceId: () => "receiver",
    push: vi.fn(), remoteImport: vi.fn(), prepareTarget: vi.fn(),
  });
  const push = vi.fn(async (_id: string, file: string) => {
    const incoming = path.join(root, "transfer.gz");
    await copyFile(file, incoming);
    const bytes = await readFile(incoming);
    return { path: incoming, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const sender = new ThreadInstanceHandoffService({
    ...common, backend: makeBackend(sourceClient), directory: path.join(root, "sender"), localInstanceId: () => "sender", push,
    prepareTarget: async (_id, request) => await receiver.prepare(request),
    remoteImport: async (_id, request) => await receiver.receive("sender", request),
  });
  return { root, sourceCwd, sourceClient, targetClient, sourceLookup, sender, push };
}

async function seedLegacySource(f: Awaited<ReturnType<typeof fixture>>, cwd = f.sourceCwd) {
  const timestamp = "2026-11-05T12:00:00Z";
  const id = randomUUID();
  const records = [
    { type: "session_meta", payload: { id, timestamp, cwd, originator: "pwragent-oracle", cli_version: "0.100.0", source: "cli", model_provider: "openai", history_mode: "legacy" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "fixture-turn", model_context_window: null } },
    { type: "event_msg", payload: { type: "user_message", message: "Contrived handoff question", images: [], local_images: [], text_elements: [] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Contrived handoff question" }] } },
    { type: "event_msg", payload: { type: "agent_message", message: "Contrived handoff answer" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Contrived handoff answer" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "fixture-turn", last_agent_message: "Contrived handoff answer" } },
  ];
  // This is generated test-owned data, never a read of Codex storage.
  const file = path.join(f.root, "legacy-fixture.jsonl");
  await writeFile(file, records.map((record) => JSON.stringify({ timestamp, ...record })).join("\n") + "\n");
  return (await f.sourceClient.forkThread({ threadId: "foreign-id-must-be-ignored", path: file, cwd })).threadId;
}

it.each(["copy", "move"] as const)("%s preserves legacy history through two real isolated Codex servers", async (operation) => {
  const f = await fixture();
  const sourceThreadId = await seedLegacySource(f);
  const before = await f.sourceClient.readThread({ threadId: sourceThreadId });
  expect(before.messages.map((message) => message.text)).toEqual(["Contrived handoff question", "Contrived handoff answer"]);
  await expect(f.targetClient.readThreadSummary(sourceThreadId)).rejects.toThrow();
  f.sourceLookup.mockClear();
  const result = await f.sender.send({ sourceThreadId, operation, targetInstanceId: "receiver" });
  const after = await f.targetClient.readThread({ threadId: result.threadId });
  expect(after.messages.map(({ role, text }) => ({ role, text })))
    .toEqual(before.messages.map(({ role, text }) => ({ role, text })));
  expect(result.sourceArchived).toBe(operation === "move");
  expect(f.sourceLookup).not.toHaveBeenCalled();
  expect(f.push).toHaveBeenCalledOnce();
});

it("copies a published Git workspace and its thread through real Codex path forks", async () => {
  const f = await fixture();
  const git = async (cwd: string, ...args: string[]) => await runGitCommand(cwd, args);
  await git(f.sourceCwd, "init", "-b", "main");
  await git(f.sourceCwd, "config", "user.name", "Handoff oracle");
  await git(f.sourceCwd, "config", "user.email", "oracle@example.invalid");
  await writeFile(path.join(f.sourceCwd, "code.txt"), "Contrived committed workspace\n");
  await git(f.sourceCwd, "add", ".");
  await git(f.sourceCwd, "commit", "-m", "fixture");
  const remote = path.join(f.root, "origin.git");
  const destination = path.join(f.root, "destination");
  await git(f.root, "clone", "--bare", f.sourceCwd, remote);
  await git(f.sourceCwd, "remote", "add", "origin", remote);
  await git(f.root, "clone", remote, destination);
  const sourceThreadId = await seedLegacySource(f);
  const result = await f.sender.send({ sourceThreadId, operation: "copy", targetInstanceId: "receiver", targetRepositoryPath: destination });
  expect(await readFile(path.join(result.directoryPath, "code.txt"), "utf8")).toBe("Contrived committed workspace\n");
  expect((await f.targetClient.readThread({ threadId: result.threadId })).messages).toHaveLength(2);
  expect(f.sourceLookup).not.toHaveBeenCalled();
});

it("refuses a real paginated source during prepare before pushing bytes", async () => {
  const f = await fixture();
  const { threadId } = await f.sourceClient.startThread({ cwd: f.sourceCwd });
  await f.sourceClient.injectThreadItems({ threadId, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Contrived paginated context" }] },
  ] });
  const exported = await f.sourceClient.exportThreadForHandoff(threadId);
  expect(exported.historyMode).toBe("paginated");
  // Reproduce the reported error with the path forwarded by the production
  // client. These opaque protocol bytes are staged in a test-owned file.
  const staged = path.join(f.root, "paginated-import.jsonl");
  await writeFile(staged, Buffer.from(exported.rolloutBase64, "base64"));
  await expect(f.targetClient.forkThread({ threadId, path: staged, cwd: f.root }))
    .rejects.toThrow(`no rollout found for thread id ${threadId}`);
  await expect(f.sender.send({ sourceThreadId: threadId, operation: "copy", targetInstanceId: "receiver" }))
    .rejects.toThrow(/paginated history/i);
  expect(f.push).not.toHaveBeenCalled();
  expect(f.sourceLookup).not.toHaveBeenCalled();
});
