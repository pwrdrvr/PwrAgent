import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { DesktopApi } from "../desktop-api";
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
          cwd: "/Users/huntharo/pwrdrvr/PwrAgent",
          skills: [
            {
              name: "local-fix",
              description: "Project-local skill",
              path: "/Users/huntharo/pwrdrvr/PwrAgent/.agents/skills/local-fix/SKILL.md",
              scope: "local",
              enabled: true,
            },
            {
              name: "frontend-design",
              description: "User skill",
              path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
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
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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
      cwd: "/Users/huntharo/pwrdrvr/PwrAgent",
      cwds: ["/Users/huntharo/pwrdrvr/PwrAgent"],
    });

    await waitFor(() => {
      expect(result.current.skills.map((skill) => skill.name)).toEqual([
        "frontend-design",
        "local-fix",
      ]);
    });
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
});
