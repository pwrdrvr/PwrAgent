import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { IPty } from "node-pty";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegratedTerminalService,
  resolveTerminalShell,
} from "../terminal/integrated-terminal-service";

const settingsServiceMock = vi.hoisted(() => ({
  resolveIntegratedTerminalWindowsShell: vi.fn(() => "auto"),
  resolveTerminalSpawnEnvAsync: vi.fn(async () => ({ SHELL: "/bin/sh" })),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => settingsServiceMock,
}));

beforeEach(() => {
  settingsServiceMock.resolveIntegratedTerminalWindowsShell.mockReturnValue("auto");
  settingsServiceMock.resolveTerminalSpawnEnvAsync.mockResolvedValue({
    SHELL: "/bin/sh",
  });
});

describe("resolveTerminalShell", () => {
  it("uses the login shell on POSIX", () => {
    expect(
      resolveTerminalShell({
        env: { SHELL: "/bin/bash" },
        platform: "darwin",
      }),
    ).toEqual({ file: "/bin/bash", args: ["-l"] });
  });

  it("falls back to a portable shell on Linux when SHELL is unset", () => {
    const shell = resolveTerminalShell({
      env: {},
      platform: "linux",
    });

    expect(shell.args).toEqual(["-l"]);
    expect(shell.file).not.toBe("/bin/zsh");
    expect(["/bin/bash", "/bin/sh"]).toContain(shell.file);
  });

  it("prefers PowerShell Core for the automatic Windows profile", () => {
    const binDir = mkdtempSync(
      path.join(os.tmpdir(), "pwragent-terminal-shell-"),
    );
    writeFileSync(path.join(binDir, "pwsh.exe"), "");
    writeFileSync(path.join(binDir, "powershell.exe"), "");

    expect(
      resolveTerminalShell({
        env: { PATH: binDir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "auto",
      }),
    ).toEqual({ file: "pwsh.exe", args: ["-NoLogo"] });
  });

  it("falls back through Windows PowerShell to cmd for the automatic Windows profile", () => {
    const binDir = mkdtempSync(
      path.join(os.tmpdir(), "pwragent-terminal-shell-"),
    );
    writeFileSync(path.join(binDir, "powershell.exe"), "");

    expect(
      resolveTerminalShell({
        env: { PATH: binDir, ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "auto",
      }),
    ).toEqual({ file: "powershell.exe", args: ["-NoLogo"] });

    expect(
      resolveTerminalShell({
        env: { PATH: "", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "auto",
      }),
    ).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("honors explicit Windows shell preferences", () => {
    expect(
      resolveTerminalShell({
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "pwsh",
      }),
    ).toEqual({ file: "pwsh.exe", args: ["-NoLogo"] });

    expect(
      resolveTerminalShell({
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "powershell",
      }),
    ).toEqual({ file: "powershell.exe", args: ["-NoLogo"] });

    expect(
      resolveTerminalShell({
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "cmd",
      }),
    ).toEqual({ file: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("reports native node-pty load failures without creating a session", async () => {
    const service = new IntegratedTerminalService({
      loadNodePty: async () => {
        throw new Error("native module unavailable");
      },
    });

    await expect(
      service.createOrAttach(
        {
          threadKey: "codex:thread-a",
          cwd: os.tmpdir(),
          cols: 80,
          rows: 24,
        },
        fakeWebContents(),
      ),
    ).rejects.toThrow("Terminal failed to start: native module unavailable");
  });

  it("reports pty spawn failures without keeping a dead session", async () => {
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: () => {
          throw new Error("spawn ENOENT");
        },
      }),
    });

    await expect(
      service.createOrAttach(
        {
          threadKey: "codex:thread-a",
          cwd: os.tmpdir(),
          cols: 80,
          rows: 24,
        },
        fakeWebContents(),
      ),
    ).rejects.toThrow("Terminal failed to start: spawn ENOENT");

    await expect(
      service.createOrAttach(
        {
          threadKey: "codex:thread-a",
          cwd: os.tmpdir(),
          cols: 80,
          rows: 24,
        },
        fakeWebContents(),
      ),
    ).rejects.toThrow("Terminal failed to start: spawn ENOENT");
  });

  it("does not add duplicate destroyed listeners when reattaching the same webContents", async () => {
    const pty = fakePty();
    const spawn = vi.fn(() => pty);
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: spawn as unknown as typeof import("node-pty").spawn,
      }),
    });
    const webContents = fakeWebContents();

    const first = await service.createOrAttach(
      {
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      webContents,
    );
    const second = await service.createOrAttach(
      {
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      webContents,
    );

    expect(second.sessionId).toBe(first.sessionId);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(webContents.once).toHaveBeenCalledTimes(1);
  });

  it("reports terminal sessions with a foreground command for quit confirmation", async () => {
    const pty = fakePty({ process: "sleep" });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "darwin",
    });

    const response = await service.createOrAttach(
      {
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 1,
      sessionIds: [response.sessionId],
      threadKeys: ["codex:thread-a"],
    });
  });

  it("does not report a terminal sitting idle at its shell prompt", async () => {
    const pty = fakePty({ process: "-sh" });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "darwin",
    });

    await service.createOrAttach(
      {
        threadKey: "codex:thread-idle",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 0,
      sessionIds: [],
      threadKeys: [],
    });
  });

  it("conservatively reports terminals when foreground detection is unsupported", async () => {
    const pty = fakePty({ process: "powershell.exe" });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "win32",
    });

    const response = await service.createOrAttach(
      {
        threadKey: "codex:thread-windows",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 1,
      sessionIds: [response.sessionId],
      threadKeys: ["codex:thread-windows"],
    });
  });

  it("conservatively reports terminals when foreground detection fails", async () => {
    const pty = fakePty();
    Object.defineProperty(pty, "process", {
      get: () => {
        throw new Error("foreground lookup failed");
      },
    });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "darwin",
    });

    const response = await service.createOrAttach(
      {
        threadKey: "codex:thread-lookup-failed",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 1,
      sessionIds: [response.sessionId],
      threadKeys: ["codex:thread-lookup-failed"],
    });
  });

  // The renderer has no terminal state of its own — it rebuilds from this list
  // on every mount. If the list stops being published, terminals go invisible
  // while their PTYs keep running.
  it("publishes the session list whenever it changes", async () => {
    const pty = fakePty();
    const onSessionsChanged = vi.fn();
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      now: () => 1_000,
      onSessionsChanged,
    });

    expect(service.listSessions()).toEqual([]);

    const response = await service.createOrAttach(
      { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
      fakeWebContents(),
    );

    // Windows ignores SHELL entirely and resolves PowerShell/cmd, so derive the
    // expectation rather than hardcoding the POSIX shell.
    const expectedShell = resolveTerminalShell({
      env: { SHELL: "/bin/sh" },
      platform: process.platform,
      windowsShell: "auto",
    }).file;

    expect(service.listSessions()).toEqual([
      {
        sessionId: response.sessionId,
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        shell: expectedShell,
        pid: pty.pid,
        panelHidden: false,
        createdAt: 1_000,
      },
    ]);
    expect(onSessionsChanged).toHaveBeenCalledTimes(1);

    // Collapsing the panel is a preference, not a teardown: the PTY lives on
    // and the flag is what lets the UI flag it as "running but hidden".
    service.setPanelHidden({ threadKey: "codex:thread-a", hidden: true });

    expect(onSessionsChanged).toHaveBeenCalledTimes(2);
    expect(service.listSessions()[0]?.panelHidden).toBe(true);
    expect(pty.kill).not.toHaveBeenCalled();

    // Re-attaching must NOT un-hide. The renderer mounts a pane — and so
    // attaches — for every live session, collapsed ones included, so an attach
    // is not evidence the user wants to see it. Un-hiding here re-opened every
    // collapsed terminal on any remount.
    await service.createOrAttach(
      { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
      fakeWebContents(),
    );

    expect(service.listSessions()[0]?.panelHidden).toBe(true);
    expect(onSessionsChanged).toHaveBeenCalledTimes(2);

    // Showing a panel is an explicit act.
    expect(service.revealSession("codex:thread-a")).toBe(true);
    expect(service.listSessions()[0]?.panelHidden).toBe(false);
  });

  it("refuses to reveal a thread with no live session", async () => {
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => fakePty()) as unknown as typeof import("node-pty").spawn,
      }),
    });

    // The quit dialog can sit open long after its snapshot was taken, so a
    // listed shell may already have exited. Revealing anyway made the renderer
    // open a panel for a session-less thread, which spawned a brand-new shell.
    expect(service.revealSession("codex:thread-gone")).toBe(false);
    expect(service.listSessions()).toEqual([]);
  });

  it("honors a close that arrives while the shell is still spawning", async () => {
    const pty = fakePty();
    let releaseSpawn: () => void = () => undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => {
        // Stand in for the real cost of spawning: login-shell env capture plus
        // the native node-pty load. A close landing in this window used to find
        // nothing to kill and was silently dropped.
        await spawnGate;
        return {
          spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
        };
      },
    });

    const creating = service.createOrAttach(
      { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
      fakeWebContents(),
    );

    service.close({ threadKey: "codex:thread-a" });
    releaseSpawn();
    await creating;

    expect(pty.kill).toHaveBeenCalledTimes(1);
  });

  it("does not let a dropped close shoot down a later terminal", async () => {
    const pty = fakePty();
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
    });

    // Nothing is spawning, so this close has nothing to queue against.
    service.close({ threadKey: "codex:thread-a" });

    await service.createOrAttach(
      { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
      fakeWebContents(),
    );

    expect(pty.kill).not.toHaveBeenCalled();
    expect(service.listSessions()).toHaveLength(1);
  });

  it("removes pty listeners before killing sessions during shutdown", async () => {
    const disposable = { dispose: vi.fn() };
    const pty = fakePty({
      onData: vi.fn(() => disposable),
      onExit: vi.fn(() => disposable),
    });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
    });

    await service.createOrAttach(
      {
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    service.dispose();

    expect(disposable.dispose).toHaveBeenCalledTimes(2);
    expect(pty.kill).toHaveBeenCalledTimes(1);
    expect(service.getQuitSnapshot()).toEqual({
      count: 0,
      sessionIds: [],
      threadKeys: [],
    });
  });
});

function fakeWebContents(): WebContents & {
  once: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn(),
  } as unknown as WebContents & {
    once: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

function fakePty(overrides: Partial<IPty> = {}): IPty {
  return {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    clear: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    ...overrides,
  };
}
