import { describe, expect, it } from "vitest";
import type { AppMetadata } from "../app-metadata";
import {
  buildLocalThreadDiagnosticsInfo,
  buildStarMapDiagnosticsInfo,
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
  activeProfileName: "personal",
  logFilePath: "/Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
  codexProfilePath: "/Users/operator/.codex/profiles/personal",
};

describe("local diagnostics info", () => {
  it("captures the Star Map intake target when no thread exists yet", () => {
    expect(
      buildStarMapDiagnosticsInfo(
        {
          intakeTarget: {
            instanceId: "peer-harold-mbp-2018",
            label: "Harold-MBP-2018",
            federationTarget: {
              scope: "remote",
              instanceId: "peer-harold-mbp-2018",
            },
          },
        },
        metadata,
      ),
    ).toBe([
      "Surface: Federation Star Map",
      "Thread creation state: Intake open; no thread created yet",
      "Target instance ID: peer-harold-mbp-2018",
      "Target instance label: Harold-MBP-2018",
      "Federation routing target: remote:peer-harold-mbp-2018",
      "PwrAgent profile: personal",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
      "Codex profile path: /Users/operator/.codex/profiles/personal",
    ].join("\n"));
  });

  it("keeps local thread diagnostics focused on the thread and support paths", () => {
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
      "PwrAgent profile: personal",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
      "Codex profile path: /Users/operator/.codex/profiles/personal",
    ].join("\n"));
  });

  it("identifies a remotely mounted thread and its federation owner", () => {
    const output = buildLocalThreadDiagnosticsInfo(
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
    );

    expect(output).toContain("Thread ID: remote-thread");
    expect(output).toContain(
      "Project directory/worktree path: /Users/operator/.codex/worktrees/remote/PwrAgent",
    );
    expect(output).toContain([
      "Thread/view classification: Remote Thread Mounted in Local Viewer",
      "Owner-local diagnostics: Not available from this viewer; request them from the thread-owning machine if needed",
      "Federation mount provenance: Direct",
      "Thread owner federation instance ID: owner-instance",
      "Thread owner label: Harold-MBP-M5-Max / default",
      "Thread owner hostname: Harold-MBP-M5-Max.local",
      "Thread owner profile: default",
      "Thread owner status: connected",
      "Federation routing target: remote:owner-instance",
      "Federation source backend: codex",
      "Federation source thread ID: remote-thread",
      "Viewer PwrAgent profile: personal",
      "Viewer main process PID: 4100",
      "Viewer renderer process PID: 4101",
      "Viewer PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
    ].join("\n"));
    expect(output).not.toContain("machine ID");
    expect(output).not.toContain("OS version");
    expect(output).not.toContain("architecture");
    expect(output).not.toContain("Node version");
    expect(output).not.toContain("Unavailable");
  });

  it("omits remote owner details that were not advertised", () => {
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
      "Owner-local diagnostics: Not available from this viewer; request them from the thread-owning machine if needed",
      "Federation mount provenance: Derived from mounted parent",
      "Remote viewer target instance ID: owner-instance",
      "Thread owner federation instance ID: owner-instance",
      "Thread owner label: Remote Mac",
      "Federation routing target: remote:owner-instance",
      "Federation source backend: codex",
      "Federation source thread ID: remote-thread",
    ].join("\n"));
  });

  it("uses the remote viewer as owner for an unstamped direct thread", () => {
    const output = buildLocalThreadDiagnosticsInfo(
      {
        backend: "codex",
        federationHealth: {
          enabled: true,
          role: "gateway",
          status: "connected",
          instanceId: "local-viewer-instance",
          peers: [{
            id: "remote-viewer-instance",
            label: "Remote Viewer Mac",
            role: "client",
            status: "connected",
            capabilities: ["thread_navigation", "thread_detail"],
            profileName: "work",
            host: {
              hostname: "remote-viewer.local",
              platform: "darwin",
              osVersion: "25.0.0",
              arch: "arm64",
            },
          }],
        },
        federationWindowTarget: {
          scope: "remote",
          instanceId: "remote-viewer-instance",
        },
        projectPath: "/Users/remote/.codex/worktrees/direct/PwrAgent",
        threadId: "direct-remote-thread",
        title: "Direct remote thread",
      },
      metadata,
    );

    expect(output).toContain("Thread ID: direct-remote-thread");
    expect(output).toContain(
      "Project directory/worktree path: /Users/remote/.codex/worktrees/direct/PwrAgent",
    );
    expect(output).toContain([
      "Thread/view classification: Remote Thread in Remote Viewer",
      "Owner-local diagnostics: Not available from this viewer; request them from the thread-owning machine if needed",
      "Remote viewer target instance ID: remote-viewer-instance",
      "Remote viewer target label: Remote Viewer Mac",
      "Thread owner federation instance ID: remote-viewer-instance",
      "Thread owner label: Remote Viewer Mac",
      "Thread owner hostname: remote-viewer.local",
      "Thread owner profile: work",
      "Thread owner status: connected",
      "Federation routing target: remote:remote-viewer-instance",
      "Federation source backend: codex",
      "Federation source thread ID: direct-remote-thread",
      "Viewer PwrAgent profile: personal",
      "Viewer main process PID: 4100",
      "Viewer renderer process PID: 4101",
      "Viewer PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
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
      "Owner-local diagnostics: Not available from this viewer; request them from the thread-owning machine if needed",
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
    expect(output).toContain("Viewer PwrAgent profile: personal");
    expect(output).toContain("Viewer main process PID: 4100");
  });

  it("formats the Troubleshooting payload with profile, PIDs, and log path", () => {
    expect(buildTroubleshootingDiagnosticsInfo(metadata)).toBe([
      "PwrAgent profile: personal",
      "Main process PID: 4100",
      "Renderer process PID: 4101",
      "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-personal.main.log",
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
