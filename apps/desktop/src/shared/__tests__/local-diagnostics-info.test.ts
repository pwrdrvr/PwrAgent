import { describe, expect, it } from "vitest";
import type { AppMetadata } from "../app-metadata";
import {
  buildLocalThreadDiagnosticsInfo,
  buildTroubleshootingDiagnosticsInfo,
} from "../local-diagnostics-info";

const metadata: AppMetadata = {
  applicationName: "PwrAgent",
  applicationVersion: "1.2.3",
  copyright: "Copyright © 2026 PwrDrvr LLC.",
  homepage: "https://pwragent.ai",
  documentationUrl: "https://docs.pwragent.ai",
  electronVersion: "41.2.1",
  chromeVersion: "142.0.0.0",
  nodeVersion: "24.0.0",
  mainProcessId: 4100,
  rendererProcessId: 4101,
  activeProfileName: "sstk",
  logFilePath: "/Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
  codexProfilePath: "/Users/operator/.codex/profiles/sstk",
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
      "PwrAgent profile: sstk",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
      "Codex profile path: /Users/operator/.codex/profiles/sstk",
    ].join("\n"));
  });

  it("formats the Troubleshooting payload with profile, PIDs, and log path", () => {
    expect(buildTroubleshootingDiagnosticsInfo(metadata)).toBe([
      "PwrAgent profile: sstk",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
    ].join("\n"));
  });

  it("omits unavailable renderer PIDs and labels unavailable paths", () => {
    expect(
      buildLocalThreadDiagnosticsInfo(
        {
          backend: "acp:grok",
          threadId: "thread-1",
          title: "No workspace",
        },
        {
          ...metadata,
          rendererProcessId: undefined,
          logFilePath: undefined,
          codexProfilePath: undefined,
        },
      ),
    ).toContain([
      "Main process PID: 4100",
      "PwrAgent log path: Unavailable",
      "Codex profile path: Unavailable",
    ].join("\n"));
  });
});
