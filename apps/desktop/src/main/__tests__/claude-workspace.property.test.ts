import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../claude/claude-backend";
import { ClaudeSessionStore } from "../claude/claude-session-store";

// The model owns the allocated cwd and thread identity. Provider conversation
// ids and the directory holding their history must never select project scratch.
it("keeps Claude's workspace and project scratch bound to the owner across lifecycle transitions", async () => {
  const local = path.resolve(".local");
  await mkdir(local, { recursive: true });
  const root = await mkdtemp(path.join(local, "claude-workspace-property-"));
  try {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("space name", "unicode-λ", "shell-$quote'"),
      fc.constantFrom("default", "auto", "full-access"),
      fc.boolean(),
      fc.array(fc.constantFrom("resume", "fork", "move"), { minLength: 1, maxLength: 5 }),
      async (label, executionMode, configuredInstructions, steps) => {
        const store = new ClaudeSessionStore(path.join(root, randomUUID()));
        const queries: Options[] = [];
        let completed = Promise.withResolvers<void>();
        const run = ((args: Parameters<typeof query>[0]) => {
          const options = args.options!;
          queries.push(options);
          const sdkId = options.forkSession ? randomUUID() : options.resume ?? options.sessionId!;
          async function* messages(): AsyncGenerator<SDKMessage> {
            yield { type: "system", subtype: "init", session_id: sdkId } as SDKMessage;
            yield { type: "result", subtype: "success", is_error: false, result: "Done" } as SDKMessage;
          }
          return Object.assign(messages(), { close: vi.fn() }) as unknown as Query;
        }) as typeof query;
        const open = () => new ClaudeBackend({
          store, query: run,
          getSessionInfo: vi.fn().mockResolvedValue(undefined),
          discoverModels: vi.fn().mockResolvedValue([]),
          inspectInstallation: async () => ({ executable: "/fixture/claude", authStatus: "signed-in" }),
          resolveEnv: async () => ({ PATH: "/fixture/bin", TMPDIR: "/fixture/os-scratch" }),
          emit: async (event) => {
            if (event.notification.method === "turn/completed") completed.resolve();
            if (event.notification.method === "turn/failed") completed.reject(new Error("Fake Claude turn failed"));
          },
          request: async () => ({ decision: "accept" }),
          cancelRequest: async () => {},
        });
        let backend = open();
        const source = path.join(root, "source-project");
        let cwd = path.join(root, label, "allocated-0");
        let { threadId } = await backend.startThread({
          cwd, executionMode,
          linkedDirectories: [{ id: source, kind: "worktree", label, path: source, worktreePath: cwd }],
        });
        const instructions = configuredInstructions
          ? "Keep the requested artifact. The user may explicitly authorize an external path." : undefined;
        const checkTurn = async () => {
          completed = Promise.withResolvers<void>();
          await backend.startTurn({ threadId, input: [{ type: "text", text: "Build a historical snapshot" }], instructions });
          await completed.promise;
          const options = queries.at(-1)!;
          expect(options.cwd).toBe(cwd);
          expect(options.permissionMode).toBe(executionMode === "full-access" ? "bypassPermissions" : executionMode);
          expect(options.env?.TMPDIR).toBe("/fixture/os-scratch");
          expect(options).not.toHaveProperty("continue");
          const prompt = options.systemPrompt;
          expect(prompt).toMatchObject({ type: "preset", preset: "claude_code" });
          const append = typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset"
            ? prompt.append : undefined;
          expect(append).toContain(`Authoritative workspace: ${JSON.stringify(cwd)}`);
          expect(append).toContain(`Project scratch: ${JSON.stringify(path.join(cwd, ".pwragent", "scratch", threadId))}`);
          if (instructions) expect(append).toContain(instructions);
          expect(append).toContain("source snapshots");
          expect(append).toContain("CLI-managed scratch");
          expect(append).toContain("explicitly authorizes");
        };
        try {
          await checkTurn();
          for (const [index, step] of steps.entries()) {
            const previousSdkId = (await store.read(threadId)).sdkSessionId;
            if (step === "resume") {
              await backend.close();
              backend = open();
            } else {
              cwd = path.join(root, label, `allocated-${index + 1}`);
              const linkedDirectory = { id: cwd, kind: "worktree" as const, label, path: source, worktreePath: cwd };
              if (step === "fork") {
                ({ threadId } = await backend.forkThread({ sourceThreadId: threadId, cwd, executionMode, linkedDirectories: [linkedDirectory] }));
              } else {
                await backend.moveWorkspace({ threadId, cwd, linkedDirectory });
              }
            }
            await checkTurn();
            expect(queries.at(-1)?.resume).toBe(previousSdkId);
            expect(Boolean(queries.at(-1)?.forkSession)).toBe(step === "fork");
          }
        } finally {
          await backend.close();
        }
      },
    ), { numRuns: 20, seed: 6606 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
