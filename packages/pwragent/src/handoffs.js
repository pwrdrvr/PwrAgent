import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createGitHandoffService, ThreadInstanceHandoffService, FederationFilePushReceiver,
  registerFilePushHandlers, pushFederationFile, THREAD_HANDOFF_METHODS, FILE_PUSH_METHOD_CAPABILITIES } from "../dist/federation-core.js";
import { atomicJson, digest } from "./store.js";

export const HANDOFF_CAPABILITIES = {
  ...FILE_PUSH_METHOD_CAPABILITIES,
  ...Object.fromEntries(Object.values(THREAD_HANDOFF_METHODS).map((method) => [method, "thread_handoff"])),
};

/** Adapts shared transactional intake to this daemon's protocol-owned threads. */
export function setupHandoffs(federation, directory) {
  const { runtime, backend, router } = federation;
  const receipts = new Map();
  const locked = new Set();
  const runGitCommand = (cwd, args, options) => runtime.projects.git.git(cwd, args, options);
  const receiver = new FederationFilePushReceiver({
    allowed: () => !federation.stopping,
    formatError: (error, folder, operation) => new Error(`Cannot ${operation} in outpost receiving directory "${folder}" (${error.code || "unknown error"}). Check the outpost disk and permissions.`),
    directory: () => path.join(directory, "incoming"),
    onCompleted: (peer, file) => {
      if (receipts.size >= 128) receipts.delete(receipts.keys().next().value);
      receipts.set(file.path, { peer, ...file });
    },
  });
  runtime.threadLocked = (id) => locked.has(id);
  const service = new ThreadInstanceHandoffService({
    directory: path.join(directory, "handoffs"),
    localInstanceId: () => federation.state.instanceId,
    runGitCommand,
    git: createGitHandoffService(runGitCommand),
    allocateWorktree: async (repository) => {
      const base = path.join(repository, ".worktrees");
      await mkdir(base, { recursive: true });
      return path.join(runtime.projects.contained(await realpath(base)), `outpost-${randomUUID()}`);
    },
    releaseWorktree: async () => {},
    createHistoryWorkspace: async () => {
      const cwd = path.join(runtime.projects.resolve(), `intake-${randomUUID()}`);
      await mkdir(cwd, { mode: 0o700 });
      return cwd;
    },
    assertTarget: (target) => {
      const route = router.getConnection(target);
      if (!route || !["thread_handoff", "turn_control", "environment_actions", "file_push"].every((capability) => route.capabilities.includes(capability))) {
        throw new Error("The receiving peer must be connected and grant thread handoff, turn control, environment actions and file push");
      }
    },
    push: (target, file) => pushFederationFile(federation.endpoint(target), file),
    remoteImport: (target, request) => federation.endpoint(target).request({ method: THREAD_HANDOFF_METHODS.import, params: request, timeoutMs: 120000 }),
    prepareTarget: (target, request) => federation.endpoint(target).request({ method: THREAD_HANDOFF_METHODS.prepare, params: request, timeoutMs: 120000 }),
    receipt: (peer, file) => {
      const receipt = receipts.get(file.path);
      return receipt?.peer === peer && receipt.sha256 === file.sha256 && receipt.sizeBytes === file.sizeBytes;
    },
    backend: {
      withThreadHandoff: async (id, work) => {
        backend.owned(id);
        if (locked.has(id) || runtime.active || backend.creating || runtime.intakeBusy) throw new Error("Wait for the outpost to become idle before handoff");
        locked.add(id);
        try { return await work(); } finally { locked.delete(id); }
      },
      exportThreadForHandoff: async (id) => {
        const owned = backend.owned(id);
        if (runtime.active) throw new Error("Wait for the source turn to finish");
        const result = await runtime.codex.request("thread/read", { threadId: id, includeTurns: false });
        if (result.thread?.id !== id || typeof result.thread.path !== "string") throw new Error("Codex did not provide a persisted thread for protocol export");
        const file = await runtime.codex.request("fs/readFile", { path: result.thread.path });
        if (typeof file.dataBase64 !== "string") throw new Error("Codex protocol thread export is unavailable");
        return { rolloutBase64: file.dataBase64, replay: (await backend.readThread(id)).replay,
          cwd: runtime.projects.resolve(owned.cwd || runtime.workspace), title: owned.title };
      },
      forkThread: async (request) => {
        if (runtime.active || backend.creating) throw new Error("Outpost is busy");
        backend.creating = true;
        try {
          const cwd = runtime.projects.contained(await realpath(request.directoryPath));
          if (backend.threads.size >= 10000) throw new Error("Thread retention limit reached");
          const result = await runtime.codex.request("thread/fork", { threadId: request.sourceThreadId, path: request.sourceThreadPath,
            cwd, approvalPolicy: "never", sandbox: "read-only" });
          const id = result.thread?.id;
          if (typeof id !== "string" || !id || backend.threads.has(id)) throw new Error("Invalid forked thread identity");
          backend.threads.set(id, { id, cwd, title: "Imported thread", titleSource: "fallback", createdAt: Date.now(), sandbox: "read-only" });
          runtime.loadedThreads.add(id);
          backend.persist();
          backend.invalidate(id);
          return { threadId: id };
        } finally { backend.creating = false; }
      },
      readThread: async ({ threadId }) => ({ replay: (await backend.readThread(threadId)).replay }),
      archiveThread: async ({ threadId }) => {
        backend.owned(threadId);
        await runtime.codex.request("thread/archive", { threadId });
        backend.owned(threadId).archived = true;
        backend.persist();
        backend.invalidate(threadId);
      },
      renameThread: (request) => backend.handle("backend.renameThread", request),
    },
  });
  registerFilePushHandlers(router, receiver);
  router.registerHandler(THREAD_HANDOFF_METHODS.prepare, (envelope) => {
    if (envelope.params?.repository) runtime.projects.resolve(envelope.params.repository);
    return service.prepare(envelope.params);
  });
  router.registerHandler(THREAD_HANDOFF_METHODS.send, (envelope) => service.send(envelope.params));
  // A lost acknowledgement or cold restart must never repeat a fork whose
  // outcome is uncertain. Operators reconcile it using the destination list.
  router.registerHandler(THREAD_HANDOFF_METHODS.import, async (envelope) => {
    const request = envelope.params;
    if (request?.targetRepositoryPath) runtime.projects.resolve(request.targetRepositoryPath);
    const file = path.join(directory, `intake-${digest([envelope.sourceInstanceId, request?.handoffId])}.json`);
    const fingerprint = digest(request);
    try {
      const prior = JSON.parse(await readFile(file, "utf8"));
      if (prior.fingerprint !== fingerprint) throw new Error("Intake identity was reused with different input");
      if (prior.result) return prior.result;
      throw new Error("Intake outcome is uncertain; inspect destination threads before starting a new handoff");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (runtime.active || backend.creating || runtime.intakeBusy) throw new Error("Outpost is busy; no intake was started");
    runtime.intakeBusy = true;
    try {
      atomicJson(file, { fingerprint, status: "pending" });
      const result = await service.receive(envelope.sourceInstanceId, request);
      await runtime.projects.add({ path: backend.owned(result.threadId).cwd });
      atomicJson(file, { fingerprint, status: "completed", result });
      receipts.delete(request.file.path);
      return result;
    } finally { runtime.intakeBusy = false; }
  });
  return { stop: () => receiver.dispose() };
}
