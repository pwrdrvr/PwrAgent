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
});
