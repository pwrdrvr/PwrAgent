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
  hostname: "viewer-mac.local",
  platform: "darwin",
  osVersion: "25.0.0",
  architecture: "arm64",
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
      "Thread/view classification: Local Thread in Local Viewer",
      "Federation mount provenance: Not mounted",
      "Local viewer federation instance ID: Unavailable",
      "Remote viewer target instance ID: Unavailable",
      "Remote viewer target label: Unavailable",
      "Remote viewer target hostname: Unavailable",
      "Remote viewer target machine ID: Unavailable",
      "Remote viewer target profile: Unavailable",
      "Remote viewer target status: Unavailable",
      "Thread owner federation instance ID: Unavailable",
      "Thread owner label: Unavailable",
      "Thread owner hostname: viewer-mac.local",
      "Thread owner machine ID: Unavailable",
      "Thread owner platform: darwin",
      "Thread owner OS version: 25.0.0",
      "Thread owner architecture: arm64",
      "Thread owner profile: sstk",
      "Thread owner status: Unavailable",
      "Federation routing target: local",
      "Federation source backend: codex",
      "Federation source thread ID: 019ffc54-058f-7691-9325-c8805903b37b",
      "Viewer machine hostname: viewer-mac.local",
      "Viewer platform: darwin",
      "Viewer OS version: 25.0.0",
      "Viewer architecture: arm64",
      "Viewer PwrAgent version: 1.2.3",
      "Viewer Electron version: 41.2.1",
      "Viewer Chrome version: 142.0.0.0",
      "Viewer Node version: 24.0.0",
      "Viewer PwrAgent profile: sstk",
      "Viewer main process PID: 4100",
      "Viewer renderer process PID: 4101",
      "Viewer PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-sstk.main.log",
      "Viewer Codex profile path: /Users/operator/.codex/profiles/sstk",
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
                platform: "darwin",
                osVersion: "25.0.0",
                arch: "arm64",
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
      "Thread/view classification: Remote Thread Mounted in Local Viewer",
      "Federation mount provenance: Direct",
      "Local viewer federation instance ID: viewer-instance",
      "Remote viewer target instance ID: Unavailable",
      "Remote viewer target label: Unavailable",
      "Remote viewer target hostname: Unavailable",
      "Remote viewer target machine ID: Unavailable",
      "Remote viewer target profile: Unavailable",
      "Remote viewer target status: Unavailable",
      "Thread owner federation instance ID: owner-instance",
      "Thread owner label: Harold-MBP-M5-Max / default",
      "Thread owner hostname: Harold-MBP-M5-Max.local",
      "Thread owner machine ID: machine-m5-max",
      "Thread owner platform: darwin",
      "Thread owner OS version: 25.0.0",
      "Thread owner architecture: arm64",
      "Thread owner profile: default",
      "Thread owner status: connected",
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
      "Thread/view classification: Remote Thread in Remote Viewer",
      "Federation mount provenance: Derived from mounted parent",
      "Local viewer federation instance ID: Unavailable",
      "Remote viewer target instance ID: owner-instance",
      "Remote viewer target label: Unavailable",
      "Remote viewer target hostname: Unavailable",
      "Remote viewer target machine ID: Unavailable",
      "Remote viewer target profile: Unavailable",
      "Remote viewer target status: Unavailable",
      "Thread owner federation instance ID: owner-instance",
      "Thread owner label: Remote Mac",
      "Thread owner hostname: Unavailable",
      "Thread owner machine ID: Unavailable",
      "Thread owner platform: Unavailable",
      "Thread owner OS version: Unavailable",
      "Thread owner architecture: Unavailable",
      "Thread owner profile: Unavailable",
      "Thread owner status: Unavailable",
    ].join("\n"));
  });

  it("identifies a transitive remote thread in a remote viewer", () => {
    const output = buildLocalThreadDiagnosticsInfo(
      {
        backend: "codex",
        federation: {
          ref: {
            backend: "codex",
            target: {
              scope: "remote",
              instanceId: "thread-owner-instance",
            },
            threadId: "remote-squared-thread",
          },
          instanceLabel: "Thread Owner Mac",
          derivedFromMountedParent: true,
        },
        federationWindowLabel: "Remote Viewer Mac / work",
        federationWindowTarget: {
          scope: "remote",
          instanceId: "remote-viewer-instance",
        },
        threadId: "remote-squared-thread",
        title: "Transitive remote thread",
      },
      metadata,
    );

    expect(output).toContain(
      "Thread/view classification: Remote² Thread in Remote Viewer",
    );
    expect(output).toContain(
      "Remote viewer target instance ID: remote-viewer-instance",
    );
    expect(output).toContain(
      "Remote viewer target label: Remote Viewer Mac / work",
    );
    expect(output).toContain(
      "Thread owner federation instance ID: thread-owner-instance",
    );
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
      "Viewer main process PID: 4100",
      "Viewer PwrAgent log path: Unavailable",
      "Viewer Codex profile path: Unavailable",
    ].join("\n"));
  });
});
