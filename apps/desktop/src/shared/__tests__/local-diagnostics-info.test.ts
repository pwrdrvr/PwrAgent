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
      "Thread location: Local",
      "Federation view: Local thread",
      "Federation mount provenance: Not mounted",
      "Federation viewer instance ID: Unavailable",
      "Federation owner instance ID: Unavailable",
      "Federation owner label: Unavailable",
      "Federation owner hostname: Unavailable",
      "Federation owner machine ID: Unavailable",
      "Federation owner profile: Unavailable",
      "Federation peer status: Unavailable",
      "Federation routing target: local",
      "Federation source backend: codex",
      "Federation source thread ID: 019ffc54-058f-7691-9325-c8805903b37b",
      "PwrAgent profile: sstk",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
      "Codex profile path: /Users/operator/.codex/profiles/sstk",
    ].join("\n"));
  });

  it("identifies a remotely mounted thread and its federation owner", () => {
    expect(
      buildLocalThreadDiagnosticsInfo(
        {
          backend: "codex",
          federation: {
            ref: {
              backend: "codex",
              target: {
                scope: "remote",
                instanceId: "owner-instance",
              },
              threadId: "remote-thread",
            },
            instanceLabel: "Harold-MBP-M5-Max / default",
            peerStatus: "connected",
          },
          federationHealth: {
            enabled: true,
            role: "gateway",
            status: "connected",
            instanceId: "viewer-instance",
            peers: [{
              id: "owner-instance",
              label: "Harold-MBP-M5-Max",
              role: "client",
              status: "connected",
              capabilities: ["thread_navigation", "thread_detail"],
              profileName: "default",
              host: {
                hostname: "Harold-MBP-M5-Max.local",
                machineId: "machine-m5-max",
              },
            }],
          },
          projectPath: "/Users/operator/.codex/worktrees/remote/PwrAgent",
          threadId: "remote-thread",
          title: "Screenshot Drift on pwrlab-m4",
        },
        metadata,
      ),
    ).toContain([
      "Thread location: Remote",
      "Federation view: Mounted in local window",
      "Federation mount provenance: Direct",
      "Federation viewer instance ID: viewer-instance",
      "Federation owner instance ID: owner-instance",
      "Federation owner label: Harold-MBP-M5-Max / default",
      "Federation owner hostname: Harold-MBP-M5-Max.local",
      "Federation owner machine ID: machine-m5-max",
      "Federation owner profile: default",
      "Federation peer status: connected",
      "Federation routing target: remote:owner-instance",
      "Federation source backend: codex",
      "Federation source thread ID: remote-thread",
    ].join("\n"));
  });

  it("labels unavailable remote owner details honestly", () => {
    expect(
      buildLocalThreadDiagnosticsInfo(
        {
          backend: "codex",
          federation: {
            ref: {
              backend: "codex",
              target: {
                scope: "remote",
                instanceId: "owner-instance",
              },
              threadId: "remote-thread",
            },
            instanceLabel: "Remote Mac",
            derivedFromMountedParent: true,
          },
          federationWindowTarget: {
            scope: "remote",
            instanceId: "owner-instance",
          },
          threadId: "remote-thread",
          title: "Remote thread",
        },
        metadata,
      ),
    ).toContain([
      "Federation view: Dedicated remote window",
      "Federation mount provenance: Derived from mounted parent",
      "Federation viewer instance ID: Unavailable",
      "Federation owner instance ID: owner-instance",
      "Federation owner label: Remote Mac",
      "Federation owner hostname: Unavailable",
      "Federation owner machine ID: Unavailable",
      "Federation owner profile: Unavailable",
      "Federation peer status: Unavailable",
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
