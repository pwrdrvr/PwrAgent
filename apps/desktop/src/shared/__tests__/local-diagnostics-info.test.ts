import { describe, expect, it } from "vitest";
import type { AppMetadata } from "../app-metadata";
import {
  buildLocalThreadDiagnosticsInfo,
  resolveLocalThreadDiagnosticsProjectPath,
} from "../local-diagnostics-info";

const metadata: AppMetadata = {
  applicationName: "PwrAgent",
  applicationVersion: "1.0.0",
  copyright: "Copyright © 2026 PwrDrvr LLC.",
  homepage: "https://pwragent.ai",
  documentationUrl: "https://docs.pwragent.ai",
  electronVersion: "41.2.1",
  chromeVersion: "142.0.0.0",
  nodeVersion: "24.0.0",
  mainProcessId: 4100,
  rendererProcessId: 4101,
  activeProfileName: "work",
  logFilePath: "/Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
  codexProfilePath: "/Users/operator/.codex/profiles/work",
};

describe("local diagnostics info", () => {
  it("formats the current thread and local runtime as one copyable payload", () => {
    expect(
      buildLocalThreadDiagnosticsInfo(
        {
          backend: "codex",
          projectPath: "/Users/operator/.codex/worktrees/abc/PwrAgent",
          threadId: "019ffc54-058f-7691-9325-c8805903b37b",
          title: "Fix handoff project paths and diagnostics",
        },
        metadata,
      ),
    ).toBe([
      "Thread ID: 019ffc54-058f-7691-9325-c8805903b37b",
      "Project directory/worktree path: /Users/operator/.codex/worktrees/abc/PwrAgent",
      "Provider/backend: codex",
      "Thread title: Fix handoff project paths and diagnostics",
      "PwrAgent profile: work",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
      "Codex profile path: /Users/operator/.codex/profiles/work",
    ].join("\n"));
  });

  it("uses a linked worktree when the thread has no project key", () => {
    expect(
      resolveLocalThreadDiagnosticsProjectPath({
        linkedDirectories: [
          {
            id: "directory:/repo",
            kind: "worktree",
            label: "PwrAgent",
            path: "/Users/operator/pwrdrvr/PwrAgent",
            worktreePath: "/Users/operator/.codex/worktrees/abc/PwrAgent",
          },
        ],
      }),
    ).toBe("/Users/operator/.codex/worktrees/abc/PwrAgent");
  });

  it("labels unavailable fields when no local thread is selected", () => {
    const diagnostics = buildLocalThreadDiagnosticsInfo(
      {},
      {
        ...metadata,
        rendererProcessId: undefined,
        logFilePath: undefined,
        codexProfilePath: undefined,
      },
    );

    expect(diagnostics).toContain("Thread ID: Unavailable");
    expect(diagnostics).toContain("Project directory/worktree path: Unavailable");
    expect(diagnostics).toContain([
      "Main process PID: 4100",
      "PwrAgent log path: Unavailable",
      "Codex profile path: Unavailable",
    ].join("\n"));
  });
});
