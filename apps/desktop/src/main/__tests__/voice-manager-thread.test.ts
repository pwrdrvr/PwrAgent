// Resolving the Voice manager thread overseer voice talks through. Like the
// Star Map manager, the quiet failures are a second manager on every start
// and a reopened thread that is gone. Voice adds one: the thread must be
// Codex, because live voice is a Codex App Server capability.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isVoiceManagerThread,
  openVoiceManagerThread,
  VOICE_MANAGER_THREAD_TITLE,
} from "../native-voice/voice-manager-thread";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "voice-manager-"));
});
afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function deps(options: {
  remembered?: { backend: string; threadId: string };
  threads?: Array<{ id: string; archivedAt?: number }>;
  launchpadBackend?: string;
} = {}) {
  const startThread = vi.fn(async (_params: Record<string, unknown>) => ({ backend: "codex", threadId: "sample-made" }));
  const renameThread = vi.fn(async () => ({}));
  const setVoiceManagerThread = vi.fn();
  const listThreads = vi.fn(async () => options.threads ?? []);
  return {
    startThread, renameThread, setVoiceManagerThread, listThreads,
    deps: {
      workspaceDir: () => workspace,
      registry: { startThread, renameThread, listThreads } as never,
      overlayStore: {
        getVoiceManagerThread: () => options.remembered,
        setVoiceManagerThread,
        getLaunchpadDefaults: async () => ({
          backend: options.launchpadBackend ?? "codex",
          executionMode: "default" as const,
          model: "sample-model",
          reasoningEffort: "medium",
        }),
      } as never,
    },
  };
}

describe("Voice manager thread", () => {
  it("creates a titled Codex thread with its instructions in its own workspace", async () => {
    const f = deps();
    expect(await openVoiceManagerThread(f.deps)).toEqual({ status: "ready", threadId: "sample-made", created: true });
    expect(f.startThread).toHaveBeenCalledWith(expect.objectContaining({
      backend: "codex", cwd: workspace, model: "sample-model", reasoningEffort: "medium",
      agent: expect.objectContaining({ instructions: expect.stringContaining("read_operator_focus") }),
    }));
    expect(f.renameThread).toHaveBeenCalledWith({ backend: "codex", threadId: "sample-made", name: VOICE_MANAGER_THREAD_TITLE });
    expect(f.setVoiceManagerThread).toHaveBeenCalledWith({ backend: "codex", threadId: "sample-made" });
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      expect(await fs.readFile(path.join(workspace, name), "utf8")).toContain("search_threads");
    }
  });

  it("reopens the remembered thread instead of creating a second one", async () => {
    const f = deps({ remembered: { backend: "codex", threadId: "sample-kept" }, threads: [{ id: "sample-kept" }] });
    expect(await openVoiceManagerThread(f.deps)).toEqual({ status: "ready", threadId: "sample-kept", created: false });
    expect(f.startThread).not.toHaveBeenCalled();
  });

  it("replaces an archived manager", async () => {
    const f = deps({ remembered: { backend: "codex", threadId: "sample-kept" }, threads: [{ id: "sample-kept", archivedAt: 1 }] });
    expect(await openVoiceManagerThread(f.deps)).toMatchObject({ created: true, threadId: "sample-made" });
  });

  it("starts on Codex without another provider's model when the launchpad defaults elsewhere", async () => {
    const f = deps({ launchpadBackend: "claude" });
    await openVoiceManagerThread(f.deps);
    const params = f.startThread.mock.calls[0][0];
    expect(params.backend).toBe("codex");
    expect(params).not.toHaveProperty("model");
    expect(params).not.toHaveProperty("reasoningEffort");
  });

  it("answers whether a thread is the manager", () => {
    const store = { getVoiceManagerThread: () => ({ backend: "codex", threadId: "sample-kept" }) };
    expect(isVoiceManagerThread("sample-kept", store)).toBe(true);
    expect(isVoiceManagerThread("sample-other", store)).toBe(false);
  });
});
