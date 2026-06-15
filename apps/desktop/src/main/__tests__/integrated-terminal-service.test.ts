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

function fakePty(): IPty {
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
  };
}
