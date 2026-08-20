import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../desktop-api";
import type {
  AppServerListSkillsResponse,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadSkills } from "../useThreadSkills";

describe("useThreadSkills", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads skills for a Codex directory launchpad from the local project path", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      data: [
        {
          cwd: "/Users/fixture-user/pwrdrvr/PwrAgent",
          skills: [
            {
              name: "local-fix",
              description: "Project-local skill",
              path: "/Users/fixture-user/pwrdrvr/PwrAgent/.agents/skills/local-fix/SKILL.md",
              scope: "local",
              enabled: true,
            },
            {
              name: "frontend-design",
              description: "User skill",
              path: "/Users/fixture-user/.codex/skills/frontend-design/SKILL.md",
              scope: "user",
              enabled: true,
            },
          ],
        },
      ],
    }));

    const desktopApi: DesktopApi = {
      listSkills,
    };

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi,
        launchpad: {
          directoryKey: "directory:/Users/fixture-user/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      })
    );

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(listSkills).toHaveBeenCalledWith({
      backend: "codex",
      cwd: "/Users/fixture-user/pwrdrvr/PwrAgent",
      cwds: ["/Users/fixture-user/pwrdrvr/PwrAgent"],
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "frontend-design",
        "local-fix",
      ]);
    });
  });

  it.each([
    { backend: "acp:grok" as const, directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent" },
    { backend: "acp:kimi" as const, directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent" },
    { backend: "codex" as const, directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent" },
  ])(
    "loads provider commands for an unborn $backend launchpad draft",
    async ({ backend, directoryPath }) => {
      const listSkills = vi.fn(async () => ({
        backend,
        fetchedAt: Date.now(),
        data: [
          {
            skills: [],
            commands: [
              {
                name: "compact",
                description: "Compact this thread's context.",
                backend,
                scope: "session" as const,
                source: "provider" as const,
              },
            ],
          },
        ],
      }));

      const { result } = renderHook(() =>
        useThreadSkills({
          desktopApi: { listSkills },
          launchpad: {
            directoryKey: `directory:${directoryPath}`,
            directoryKind: "directory",
            directoryLabel: "PwrAgent",
            directoryPath,
            backend,
            executionMode: "default",
            prompt: "",
            workMode: "local",
            createdAt: 1,
            updatedAt: 1,
          },
        })
      );

      await act(async () => {
        await result.current.ensureLoaded();
      });

      expect(listSkills).toHaveBeenCalledWith({
        backend,
        cwd: directoryPath,
        cwds: [directoryPath],
      });

      await waitFor(() => {
        expect(result.current.providerCommands.map((command) => command.name)).toEqual([
          "compact",
        ]);
      });
    },
  );

  it("requests the base repository path for a worktree-mode launchpad draft", async () => {
    // `workMode: "worktree"` drafts carry the *source* checkout in
    // `directoryPath` — the worktree itself does not exist until launch — so
    // the hook must forward that path unchanged rather than invent one.
    const listSkills = vi.fn(async () => ({
      backend: "acp:grok" as const,
      fetchedAt: Date.now(),
      data: [{ skills: [], commands: [] }],
    }));

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi: { listSkills },
        launchpad: {
          directoryKey: "directory:/Users/fixture-user/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/fixture-user/pwrdrvr/PwrAgent",
          backend: "acp:grok",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "feature/x",
          createdAt: 1,
          updatedAt: 1,
        },
      })
    );

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(listSkills).toHaveBeenCalledWith({
      backend: "acp:grok",
      cwd: "/Users/fixture-user/pwrdrvr/PwrAgent",
      cwds: ["/Users/fixture-user/pwrdrvr/PwrAgent"],
    });
  });

  it("issues one launchpad skills request across a burst of composer triggers", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "acp:grok" as const,
      fetchedAt: Date.now(),
      data: [{ skills: [], commands: [] }],
    }));

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi: { listSkills },
        launchpad: {
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "repo",
          directoryPath: "/repo",
          backend: "acp:grok",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        },
      })
    );

    // The composer calls `onEnsureSkillsLoaded` on every keystroke after `/`.
    await act(async () => {
      await Promise.all([
        result.current.ensureLoaded(),
        result.current.ensureLoaded(),
        result.current.ensureLoaded(),
      ]);
    });
    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(listSkills).toHaveBeenCalledTimes(1);
  });

  it("loads provider commands for an ACP thread session", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "acp:kimi" as const,
      fetchedAt: Date.now(),
      data: [
        {
          skills: [],
          commands: [
            {
              name: "skill:frontend-design",
              description: "Load frontend-design",
              aliases: ["fd"],
              backend: "acp:kimi" as const,
              scope: "session" as const,
              source: "provider" as const,
            },
          ],
        },
      ],
    }));

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi: { listSkills },
        thread: {
          id: "session-1",
          title: "Kimi session",
          titleSource: "explicit",
          source: "acp:kimi",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
      })
    );

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(listSkills).toHaveBeenCalledWith({
      backend: "acp:kimi",
      threadId: "session-1",
    });

    await waitFor(() => {
      expect(result.current.skills).toEqual([]);
      expect(result.current.providerCommands.map((command) => command.name)).toEqual([
        "skill:frontend-design",
      ]);
    });
  });

  it("refreshes cached Codex skills when the backend reports skill metadata changed", async () => {
    const listSkills = vi
      .fn()
      .mockResolvedValueOnce({
        backend: "codex" as const,
        fetchedAt: Date.now(),
        data: [
          {
            skills: [
              {
                name: "old-skill",
                description: "Old skill",
                path: "/Users/fixture-user/.codex/skills/old-skill/SKILL.md",
                scope: "user" as const,
                enabled: true,
              },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        backend: "codex" as const,
        fetchedAt: Date.now(),
        data: [
          {
            skills: [
              {
                name: "new-skill",
                description: "New skill",
                path: "/Users/fixture-user/.codex/skills/new-skill/SKILL.md",
                scope: "user" as const,
                enabled: true,
              },
            ],
          },
        ],
      });
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      listSkills,
      onAgentEvent: (handler) => {
        agentEventHandler = handler;
        return () => {
          agentEventHandler = undefined;
        };
      },
    };

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi,
        thread: {
          id: "thread-1",
          title: "Create skill",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
      })
    );

    await act(async () => {
      await result.current.ensureLoaded();
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "old-skill",
      ]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "skills/changed",
          params: {},
        },
      });
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "new-skill",
      ]);
    });
    expect(listSkills).toHaveBeenCalledTimes(2);
    expect(listSkills).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("ignores stale in-flight skill responses for cache keys cleared by skills/changed", async () => {
    const createThread = (id: string): NavigationThreadSummary => ({
      id,
      title: id,
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
    });
    const createResponse = (name: string): AppServerListSkillsResponse => ({
      backend: "codex",
      fetchedAt: Date.now(),
      data: [
        {
          skills: [
            {
              name,
              description: name,
              path: `/Users/fixture-user/.codex/skills/${name}/SKILL.md`,
              scope: "user",
              enabled: true,
            },
          ],
        },
      ],
    });
    let resolveThreadA:
      | ((response: AppServerListSkillsResponse) => void)
      | undefined;
    let threadARequestCount = 0;
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const listSkills = vi.fn((request) => {
      if (request?.threadId === "thread-a") {
        threadARequestCount += 1;
        if (threadARequestCount === 1) {
          return new Promise<AppServerListSkillsResponse>((resolve) => {
            resolveThreadA = resolve;
          });
        }
        return Promise.resolve(createResponse("fresh-a"));
      }

      return Promise.resolve(createResponse("thread-b"));
    });
    const desktopApi: DesktopApi = {
      listSkills,
      onAgentEvent: (handler) => {
        agentEventHandler = handler;
        return () => {
          agentEventHandler = undefined;
        };
      },
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSkills({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: createThread("thread-a"),
        },
      },
    );

    act(() => {
      void result.current.ensureLoaded();
    });

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-a",
      });
    });

    rerender({ thread: createThread("thread-b") });
    await act(async () => {
      await result.current.ensureLoaded();
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "thread-b",
      ]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "skills/changed",
          params: {},
        },
      });
    });

    await act(async () => {
      resolveThreadA?.(createResponse("stale-a"));
      await Promise.resolve();
    });

    rerender({ thread: createThread("thread-a") });
    await act(async () => {
      await result.current.ensureLoaded();
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "fresh-a",
      ]);
    });
    expect(threadARequestCount).toBe(2);
  });

  it("updates cached ACP provider commands when session metadata changes", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "acp:kimi" as const,
      fetchedAt: Date.now(),
      data: [
        {
          skills: [],
          commands: [],
        },
      ],
    }));
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      listSkills,
      onAgentEvent: (handler) => {
        agentEventHandler = handler;
        return () => {
          agentEventHandler = undefined;
        };
      },
    };

    const { result } = renderHook(() =>
      useThreadSkills({
        desktopApi,
        thread: {
          id: "session-1",
          title: "Kimi session",
          titleSource: "explicit",
          source: "acp:kimi",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        },
      })
    );

    await act(async () => {
      await result.current.ensureLoaded();
    });

    expect(result.current.providerCommands).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "acp:kimi",
        notification: {
          method: "thread/availableCommands/updated",
          params: {
            threadId: "session-1",
            commands: [
              {
                name: "skill:frontend-design",
                description: "Load frontend-design",
                backend: "acp:kimi",
                scope: "session",
                source: "provider",
              },
            ],
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.providerCommands.map((command) => command.name)).toEqual([
        "skill:frontend-design",
      ]);
    });
    expect(listSkills).toHaveBeenCalledTimes(1);
  });
});
