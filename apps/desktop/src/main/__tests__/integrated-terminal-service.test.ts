import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import type { IPty } from "node-pty";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntegratedTerminalService,
  prependIntegratedTerminalRuntimePaths,
  prepareIntegratedTerminalShellEnvironment,
  resolveTerminalShell,
  writeZshIntegrationDirectory,
} from "../terminal/integrated-terminal-service";

const settingsServiceMock = vi.hoisted(() => ({
  resolveIntegratedTerminalWindowsShell: vi.fn(() => "auto"),
  resolveIntegratedTerminalCommands: vi.fn(() => [] as string[]),
  resolveTerminalSpawnEnvAsync: vi.fn(
    async (): Promise<NodeJS.ProcessEnv> => ({ SHELL: "/bin/sh" }),
  ),
}));

vi.mock("../settings/desktop-settings-singleton", () => ({
  getDesktopSettingsService: () => settingsServiceMock,
}));

const temporaryRoots: string[] = [];

/** Fixture roots for the tests that need real files on disk. */
function createTemporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { force: true, recursive: true });
  }
  temporaryRoots.length = 0;
});

beforeEach(() => {
  settingsServiceMock.resolveIntegratedTerminalWindowsShell.mockReturnValue("auto");
  settingsServiceMock.resolveIntegratedTerminalCommands.mockReturnValue([]);
  settingsServiceMock.resolveTerminalSpawnEnvAsync.mockResolvedValue({
    SHELL: "/bin/sh",
  });
});

describe("integrated terminal runtime PATH", () => {
  it("puts selected Codex and Grok runtime directories first without duplicates", () => {
    expect(
      prependIntegratedTerminalRuntimePaths(
        {
          PATH: "/opt/homebrew/bin:/managed/codex/bin:/usr/bin",
        },
        [
          "/managed/codex/bin/codex",
          "/managed/grok/bin/grok",
          "/managed/codex/bin/codex",
          "codex",
        ],
        "darwin",
      ),
    ).toMatchObject({
      PATH: "/managed/codex/bin:/managed/grok/bin:/opt/homebrew/bin:/usr/bin",
      PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX:
        "/managed/codex/bin:/managed/grok/bin",
    });
  });

  it("wires the zsh startup integration without changing other shells", async () => {
    const zshEnv = await prepareIntegratedTerminalShellEnvironment({
      env: {
        HOME: "/Users/alice",
        PATH: "/managed/codex/bin:/usr/bin",
        PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX:
          "/managed/codex/bin",
      },
      platform: "darwin",
      resolveZshIntegrationDirectory: async () => "/pwragent/zsh-integration",
      shell: "/bin/zsh",
    });
    expect(zshEnv).toMatchObject({
      ZDOTDIR: "/pwragent/zsh-integration",
      PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: "/Users/alice",
      PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET: "1",
      PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR:
        "/pwragent/zsh-integration",
    });

    const bashEnv = await prepareIntegratedTerminalShellEnvironment({
      env: {
        PATH: "/managed/codex/bin:/usr/bin",
        PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX:
          "/managed/codex/bin",
      },
      platform: "darwin",
      resolveZshIntegrationDirectory: async () => "/unused",
      shell: "/bin/bash",
    });
    expect(bashEnv).not.toHaveProperty("ZDOTDIR");
  });

  it.skipIf(process.platform !== "darwin")(
    "reasserts the selected runtime after zsh login files rewrite PATH",
    async () => {
      const root = createTemporaryRoot("pwragent-zsh-path-");
      const integrationDir = path.join(root, "integration");
      const originalZdotdir = path.join(root, "original");
      const managedBin = path.join(root, "managed");
      const otherBin = path.join(root, "other");
      mkdirSync(originalZdotdir, { recursive: true });
      mkdirSync(managedBin, { recursive: true });
      mkdirSync(otherBin, { recursive: true });
      const managedCodex = path.join(managedBin, "codex");
      const otherCodex = path.join(otherBin, "codex");
      writeFileSync(managedCodex, "#!/bin/sh\nexit 0\n");
      writeFileSync(otherCodex, "#!/bin/sh\nexit 0\n");
      chmodSync(managedCodex, 0o700);
      chmodSync(otherCodex, 0o700);
      writeFileSync(
        path.join(originalZdotdir, ".zprofile"),
        [
          "typeset PWRAGENT_TEST_TOP_LEVEL=preserved",
          `export PATH="${otherBin}:$PATH"`,
          "",
        ].join("\n"),
      );
      await writeZshIntegrationDirectory(integrationDir);

      expect(existsSync("/bin/zsh")).toBe(true);
      const resolved = execFileSync(
        "/bin/zsh",
        [
          "-lic",
          "print -r -- \"$(command -v codex)|${PWRAGENT_TEST_TOP_LEVEL:-missing}\"",
        ],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: originalZdotdir,
            PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR: integrationDir,
            PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: managedBin,
            ZDOTDIR: integrationDir,
          },
        },
      ).trim();

      expect(resolved).toBe(`${managedCodex}|preserved`);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "preserves a ZDOTDIR selected by the user zsh startup files",
    async () => {
      const root = createTemporaryRoot("pwragent-zsh-zdotdir-");
      const integrationDir = path.join(root, "integration");
      const originalZdotdir = path.join(root, "original");
      const selectedZdotdir = path.join(root, "selected");
      mkdirSync(originalZdotdir, { recursive: true });
      mkdirSync(selectedZdotdir, { recursive: true });
      writeFileSync(
        path.join(originalZdotdir, ".zshenv"),
        `ZDOTDIR="${selectedZdotdir}"\n`,
      );
      writeFileSync(
        path.join(selectedZdotdir, ".zprofile"),
        "typeset PWRAGENT_SELECTED_ZDOTDIR_PROFILE=loaded\n",
      );
      await writeZshIntegrationDirectory(integrationDir);

      const resolved = execFileSync(
        "/bin/zsh",
        [
          "-lic",
          "print -r -- \"$ZDOTDIR|${PWRAGENT_SELECTED_ZDOTDIR_PROFILE:-missing}\"",
        ],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR: integrationDir,
            PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: originalZdotdir,
            PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET: "1",
            PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "/managed/bin",
            ZDOTDIR: integrationDir,
          },
        },
      ).trim();

      expect(resolved).toBe(`${selectedZdotdir}|loaded`);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "restores ZDOTDIR for a zsh that reads only .zshenv",
    async () => {
      const root = createTemporaryRoot("pwragent-zsh-child-");
      const integrationDir = path.join(root, "integration");
      const originalZdotdir = path.join(root, "original");
      mkdirSync(originalZdotdir, { recursive: true });
      await writeZshIntegrationDirectory(integrationDir);

      // A non-interactive, non-login zsh reads .zshenv and nothing else. Left
      // unrestored it hands PwrAgent's ZDOTDIR to every one of its children.
      const resolved = execFileSync(
        "/bin/zsh",
        ["-c", 'print -r -- "${ZDOTDIR-unset}|${PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX-unset}"'],
        {
          encoding: "utf8",
          env: {
            HOME: root,
            PATH: "/usr/bin:/bin",
            PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR: integrationDir,
            PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: originalZdotdir,
            PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET: "1",
            PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "/managed/bin",
            ZDOTDIR: integrationDir,
          },
        },
      ).trim();

      expect(resolved).toBe("unset|unset");
    },
  );

  it("drops runtime path state inherited from a parent PwrAgent terminal", () => {
    // PwrAgent launched from a PwrAgent terminal inherits these through
    // process.env, and the wrapper reapplies whatever prefix it finds.
    const env = prependIntegratedTerminalRuntimePaths(
      {
        PATH: "/usr/bin",
        // Windows preserves the casing a variable was set with, and this is a
        // plain object, so the delete has to be case-insensitive.
        Pwragent_Integrated_Terminal_Runtime_Path_Prefix: "/stale/mixed",
        PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "/stale/bin",
        PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR: "/stale/integration",
        PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: "/stale/home",
        PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET: "1",
      },
      [],
      "darwin",
    );

    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX",
    );
    expect(env).not.toHaveProperty(
      "Pwragent_Integrated_Terminal_Runtime_Path_Prefix",
    );
    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR",
    );
    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR",
    );
    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET",
    );
    expect(env.PATH).toBe("/usr/bin");
  });

  it("pins the runtime directory on a Windows terminal", () => {
    const env = prependIntegratedTerminalRuntimePaths(
      { Path: "C:\\Windows" },
      ["C:\\managed\\codex\\codex.exe"],
      "win32",
    );

    expect(env.Path).toBe("C:\\managed\\codex;C:\\Windows");
    // Read by the PowerShell command the Windows shell resolution appends.
    expect(env.PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX).toBe(
      "C:\\managed\\codex",
    );
  });

  it("leaves no ZDOTDIR state behind when the integration directory fails", async () => {
    const env = await prepareIntegratedTerminalShellEnvironment({
      env: {
        HOME: "/Users/alice",
        PATH: "/managed/codex/bin:/usr/bin",
        PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "/managed/codex/bin",
      },
      platform: "darwin",
      resolveZshIntegrationDirectory: async () => {
        throw new Error("ENOSPC");
      },
      shell: "/bin/zsh",
    });

    expect(env).not.toHaveProperty("ZDOTDIR");
    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR",
    );
    expect(env).not.toHaveProperty(
      "PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET",
    );
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

  it("reasserts the runtime path after the PowerShell profile", () => {
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX:
        "C:\\managed\\codex;C:\\managed\\grok",
    };

    for (const windowsShell of ["pwsh", "powershell"] as const) {
      const shell = resolveTerminalShell({
        env,
        platform: "win32",
        windowsShell,
      });
      // PwrAgent passes -NoLogo and never -NoProfile, so $PROFILE runs and can
      // prepend to $env:Path the way .zprofile does. -Command runs after it.
      expect(shell.args.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-Command"]);
      expect(shell.args).toHaveLength(4);
      expect(shell.args[3]).toContain(
        "PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX",
      );
      expect(shell.args[3]).toContain("$env:Path = $p + ';' + $c");
      expect(shell.args[3]).toContain("Remove-Item Env:");
      // node-pty wraps an argument containing spaces in double quotes and
      // backslash-escapes any inside it. Carrying none keeps the command the
      // shell receives byte-identical to the one generated here.
      expect(shell.args[3]).not.toContain('"');
    }
  });

  it("does not let a pinned directory decide which PowerShell to launch", () => {
    // `commandExistsOnPath` stats the filesystem, so the bundled pwsh has to
    // really be there: a fixture path that does not exist would make this pass
    // whether or not discovery skips the pinned directory.
    const bundle = createTemporaryRoot("pwragent-pinned-shell-");
    writeFileSync(path.join(bundle, "pwsh.exe"), "");

    const shell = resolveTerminalShell({
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        Path: `${bundle};C:\\Windows\\System32`,
        PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: bundle,
      },
      platform: "win32",
      windowsShell: "auto",
    });

    // A `pwsh.exe` shipped inside a Codex or Grok release must not become the
    // shell PwrAgent launches; discovery falls through to ComSpec instead.
    expect(shell.file).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it("leaves the PowerShell invocation alone when nothing is pinned", () => {
    expect(
      resolveTerminalShell({
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        platform: "win32",
        windowsShell: "pwsh",
      }),
    ).toEqual({ file: "pwsh.exe", args: ["-NoLogo"] });
  });

  it("does not add a reassertion to cmd, which cannot cheaply test PATH", () => {
    expect(
      resolveTerminalShell({
        env: {
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "C:\\managed\\codex",
        },
        platform: "win32",
        windowsShell: "cmd",
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

  it("does not pass PwrAgent's renderer URL to an integrated terminal", async () => {
    const pty = fakePty();
    let spawnOptions: { env?: NodeJS.ProcessEnv } | undefined;
    const spawn = vi.fn((...args: unknown[]) => {
      spawnOptions = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      return pty;
    });
    settingsServiceMock.resolveTerminalSpawnEnvAsync.mockResolvedValue({
      ELECTRON_RENDERER_URL: "http://localhost:5175",
      KEEP_TERMINAL_ENV: "yes",
      PATH: "/opt/homebrew/bin:/usr/bin",
      SHELL: "/bin/sh",
    });
    settingsServiceMock.resolveIntegratedTerminalCommands.mockReturnValue([
      "/managed/codex/bin/codex",
      "/managed/grok/bin/grok",
    ]);
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: spawn as unknown as typeof import("node-pty").spawn,
      }),
      platform: "darwin",
    });

    await service.createOrAttach(
      {
        threadKey: "codex:thread-renderer-env",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(spawnOptions?.env).not.toHaveProperty("ELECTRON_RENDERER_URL");
    expect(spawnOptions?.env).toMatchObject({
      KEEP_TERMINAL_ENV: "yes",
      PATH:
        "/managed/codex/bin:/managed/grok/bin:/opt/homebrew/bin:/usr/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
  });

  it("wires the zsh startup integration through the real spawn path", async () => {
    const pty = fakePty();
    let spawnOptions: { env?: NodeJS.ProcessEnv } | undefined;
    const spawn = vi.fn((...args: unknown[]) => {
      spawnOptions = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      return pty;
    });
    // Every other test of this feature calls the helpers directly, so the one
    // function that actually spawns the PTY had no coverage of the ZDOTDIR
    // half — a `/bin/sh` login shell leaves at the `basename !== "zsh"` guard.
    settingsServiceMock.resolveTerminalSpawnEnvAsync.mockResolvedValue({
      HOME: "/Users/alice",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
    });
    settingsServiceMock.resolveIntegratedTerminalCommands.mockReturnValue([
      "/managed/codex/bin/codex",
    ]);
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: spawn as unknown as typeof import("node-pty").spawn,
      }),
      platform: "darwin",
    });

    await service.createOrAttach(
      {
        threadKey: "codex:thread-zsh-env",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(spawnOptions?.env).toMatchObject({
      PATH: "/managed/codex/bin:/usr/bin",
      PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX: "/managed/codex/bin",
      PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR: "/Users/alice",
      PWRAGENT_INTEGRATED_TERMINAL_ORIGINAL_ZDOTDIR_UNSET: "1",
    });
    expect(spawnOptions?.env?.ZDOTDIR).toBe(
      spawnOptions?.env?.PWRAGENT_INTEGRATED_TERMINAL_INTEGRATION_ZDOTDIR,
    );
    expect(spawnOptions?.env?.ZDOTDIR).toContain("shell-integration");
  });

  it("carries the PowerShell reassertion through the real spawn path", async () => {
    const pty = fakePty();
    let spawnArgs: string[] | undefined;
    const spawn = vi.fn((...args: unknown[]) => {
      spawnArgs = args[1] as string[];
      return pty;
    });
    // `resolveTerminalShell` only sees the prefix because the PATH prepend runs
    // first in `spawnTerminalPty`. Nothing enforces that order, and every other
    // test hands the resolver a hand-built env, so a swap of those two
    // statements would drop the Windows reassertion with the suite still green.
    settingsServiceMock.resolveIntegratedTerminalWindowsShell.mockReturnValue(
      "pwsh",
    );
    settingsServiceMock.resolveTerminalSpawnEnvAsync.mockResolvedValue({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      Path: "C:\\Windows\\System32",
    });
    settingsServiceMock.resolveIntegratedTerminalCommands.mockReturnValue([
      "C:\\managed\\codex\\codex.exe",
    ]);
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: spawn as unknown as typeof import("node-pty").spawn,
      }),
      platform: "win32",
    });

    await service.createOrAttach(
      {
        threadKey: "codex:thread-windows-pin",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(spawnArgs?.slice(0, 3)).toEqual(["-NoLogo", "-NoExit", "-Command"]);
    expect(spawnArgs?.[3]).toContain(
      "PWRAGENT_INTEGRATED_TERMINAL_RUNTIME_PATH_PREFIX",
    );
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
      threads: [
        { sessionId: response.sessionId, threadKey: "codex:thread-a" },
      ],
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
      threads: [],
    });
  });

  it("reports a Linux foreground pipeline when node-pty falls back to the shell name", async () => {
    const pty = fakePty({ pid: 321, process: "sh" });
    const serviceOptions = {
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "linux" as const,
      readLinuxProcessStat: () => "321 (sh) S 1 321 321 34816 654",
    };
    const service = new IntegratedTerminalService(serviceOptions);

    const response = await service.createOrAttach(
      {
        threadKey: "codex:thread-linux-pipeline",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 1,
      sessionIds: [response.sessionId],
      threads: [
        { sessionId: response.sessionId, threadKey: "codex:thread-linux-pipeline" },
      ],
    });
  });

  it("does not report a Linux terminal whose shell owns the foreground process group", async () => {
    const pty = fakePty({ pid: 321, process: "sh" });
    const serviceOptions = {
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "linux" as const,
      readLinuxProcessStat: () => "321 (sh) S 1 321 321 34816 321",
    };
    const service = new IntegratedTerminalService(serviceOptions);

    await service.createOrAttach(
      {
        threadKey: "codex:thread-linux-idle",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 0,
      sessionIds: [],
      threads: [],
    });
  });

  it("conservatively reports a Linux terminal when process-group lookup fails", async () => {
    const pty = fakePty({ pid: 321, process: "sh" });
    const serviceOptions = {
      loadNodePty: async () => ({
        spawn: vi.fn(() => pty) as unknown as typeof import("node-pty").spawn,
      }),
      platform: "linux" as const,
      readLinuxProcessStat: () => {
        throw new Error("proc unavailable");
      },
    };
    const service = new IntegratedTerminalService(serviceOptions);

    const response = await service.createOrAttach(
      {
        threadKey: "codex:thread-linux-lookup-failed",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    expect(service.getQuitSnapshot()).toEqual({
      count: 1,
      sessionIds: [response.sessionId],
      threads: [
        { sessionId: response.sessionId, threadKey: "codex:thread-linux-lookup-failed" },
      ],
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
      threads: [
        { sessionId: response.sessionId, threadKey: "codex:thread-windows" },
      ],
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
      threads: [
        { sessionId: response.sessionId, threadKey: "codex:thread-lookup-failed" },
      ],
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
    service.setPanelHidden({ sessionId: response.sessionId, hidden: true });

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
    expect(service.revealSession(response.sessionId)).toEqual({
      threadKey: "codex:thread-a",
    });
    expect(service.listSessions()[0]?.panelHidden).toBe(false);
  });

  // The point of the identity refactor. A thread key groups terminals; it no
  // longer names one, and every operation below has to land on exactly the
  // shell it addressed.
  describe("several terminals on one thread", () => {
    /** Two live terminals on `codex:thread-a`, oldest first. */
    async function openTwoOnOneThread(
      options: { ptyProcess?: string } = {},
    ) {
      // `sleep` rather than the shell: a shell sitting at its own prompt is
      // filtered out of the quit snapshot, and one of the tests below needs
      // both terminals to be work in progress.
      const ptys = [
        fakePty({ process: options.ptyProcess ?? "sh" }),
        fakePty({ process: options.ptyProcess ?? "sh" }),
      ];
      let spawned = 0;
      const service = new IntegratedTerminalService({
        loadNodePty: async () => ({
          spawn: vi.fn(() => ptys[spawned++]!) as unknown as typeof import("node-pty").spawn,
        }),
        platform: "darwin",
      });
      const first = await service.createOrAttach(
        { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
        fakeWebContents(),
      );
      // A request naming an id main does not know spawns UNDER that id, which
      // is how a caller gets a second shell on a thread that already has one.
      const second = await service.createOrAttach(
        {
          sessionId: "terminal-2",
          threadKey: "codex:thread-a",
          cwd: os.tmpdir(),
          cols: 80,
          rows: 24,
        },
        fakeWebContents(),
      );
      expect(second.sessionId).toBe("terminal-2");
      expect(service.listSessions()).toHaveLength(2);
      return { first, ptys, second, service };
    }

    it("spawns a second shell for a thread that already has one", async () => {
      const { first, second, service } = await openTwoOnOneThread();

      expect(first.sessionId).not.toBe(second.sessionId);
      expect(
        service.listSessions().map((session) => session.threadKey),
      ).toEqual(["codex:thread-a", "codex:thread-a"]);
    });

    // A request with no id still means "this thread's terminal", which is what
    // keeps the Star Map window and the thread view on one shell.
    it("attaches an id-less request to the thread's oldest terminal", async () => {
      const { first, service } = await openTwoOnOneThread();

      const reattached = await service.createOrAttach(
        { threadKey: "codex:thread-a", cwd: os.tmpdir(), cols: 80, rows: 24 },
        fakeWebContents(),
      );

      expect(reattached.sessionId).toBe(first.sessionId);
      expect(service.listSessions()).toHaveLength(2);
    });

    it("collapses one terminal's panel and leaves its sibling showing", async () => {
      const { first, second, service } = await openTwoOnOneThread();

      service.setPanelHidden({ sessionId: second.sessionId, hidden: true });

      const hiddenBySession = new Map(
        service
          .listSessions()
          .map((session) => [session.sessionId, session.panelHidden]),
      );
      expect(hiddenBySession.get(first.sessionId)).toBe(false);
      expect(hiddenBySession.get(second.sessionId)).toBe(true);
    });

    it("closes one terminal and leaves the rest of the thread running", async () => {
      const { ptys, second, service } = await openTwoOnOneThread();

      service.close({ sessionId: second.sessionId });

      expect(ptys[0]?.kill).not.toHaveBeenCalled();
      expect(ptys[1]?.kill).toHaveBeenCalledTimes(1);
    });

    // The thread view's close button says "put this thread's terminal away",
    // and a pane whose create has not resolved has no id to name.
    it("closes every terminal the thread owns when the request names the thread", async () => {
      const { ptys, service } = await openTwoOnOneThread();

      service.close({ threadKey: "codex:thread-a" });

      expect(ptys[0]?.kill).toHaveBeenCalledTimes(1);
      expect(ptys[1]?.kill).toHaveBeenCalledTimes(1);
    });

    // Two shells holding up the quit are two rows. Keyed by thread they
    // collapsed into one, and the dialog under-reported what it was about to
    // kill.
    it("reports each of a thread's terminals as its own quit blocker", async () => {
      const { first, second, service } = await openTwoOnOneThread({
        ptyProcess: "sleep",
      });

      const snapshot = service.getQuitSnapshot();

      expect(snapshot.count).toBe(2);
      expect(
        [...snapshot.threads].map((thread) => thread.sessionId).sort(),
      ).toEqual([first.sessionId, second.sessionId].sort());
      expect(
        snapshot.threads.every(
          (thread) => thread.threadKey === "codex:thread-a",
        ),
      ).toBe(true);
    });

    // The one operation an operator triggers by hand from the quit dialog,
    // and the only one whose scoping was not pinned anywhere.
    it("reveals the terminal it names and leaves its sibling collapsed", async () => {
      const { first, second, service } = await openTwoOnOneThread();
      service.setPanelHidden({ sessionId: first.sessionId, hidden: true });
      service.setPanelHidden({ sessionId: second.sessionId, hidden: true });

      expect(service.revealSession(second.sessionId)).toEqual({
        threadKey: "codex:thread-a",
      });

      const hiddenBySession = new Map(
        service
          .listSessions()
          .map((session) => [session.sessionId, session.panelHidden]),
      );
      expect(hiddenBySession.get(second.sessionId)).toBe(false);
      expect(hiddenBySession.get(first.sessionId)).toBe(true);
    });

    // An id names one shell. A request whose id has already exited means
    // "that one is gone" — widening to the thread would take the operator's
    // other terminals down with a close they never issued.
    it("closes nothing when the named terminal is already gone", async () => {
      const { ptys, service } = await openTwoOnOneThread();

      service.close({
        sessionId: "terminal-that-exited",
        threadKey: "codex:thread-a",
      });

      expect(ptys[0]?.kill).not.toHaveBeenCalled();
      expect(ptys[1]?.kill).not.toHaveBeenCalled();
      expect(service.listSessions()).toHaveLength(2);
    });

    it("refuses to attach a terminal that belongs to a different thread", async () => {
      const { second, service } = await openTwoOnOneThread();

      // A pane holding a stale id must not be handed another thread's shell:
      // it would show one thread's output and send its keystrokes there.
      await expect(
        service.createOrAttach(
          {
            sessionId: second.sessionId,
            threadKey: "codex:thread-b",
            cwd: os.tmpdir(),
            cols: 80,
            rows: 24,
          },
          fakeWebContents(),
        ),
      ).rejects.toThrow(/different thread/);
    });
  });

  // Two of a thread's terminals spawning at once, and a close for one of
  // them. Keyed by thread the queued close could not tell them apart and
  // killed both — a shell the user never dismissed, dying because a sibling
  // was dismissed while both were still starting.
  it("honors a close for the terminal still spawning and spares its sibling", async () => {
    // Distinct pids so the assertion can correlate a pty back to the terminal
    // it was spawned for, rather than assuming which spawn won the race.
    const ptys = [fakePty({ pid: 101 }), fakePty({ pid: 102 })];
    let spawned = 0;
    let releaseSpawn: () => void = () => undefined;
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve;
    });
    const service = new IntegratedTerminalService({
      loadNodePty: async () => {
        await spawnGate;
        return {
          spawn: vi.fn(() => ptys[spawned++]!) as unknown as typeof import("node-pty").spawn,
        };
      },
    });

    const survivor = service.createOrAttach(
      {
        sessionId: "terminal-1",
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );
    const dismissed = service.createOrAttach(
      {
        sessionId: "terminal-2",
        threadKey: "codex:thread-a",
        cwd: os.tmpdir(),
        cols: 80,
        rows: 24,
      },
      fakeWebContents(),
    );

    service.close({ sessionId: "terminal-2" });
    releaseSpawn();
    await Promise.all([survivor, dismissed]);

    const sessionIdByPid = new Map(
      service.listSessions().map((session) => [session.pid, session.sessionId]),
    );
    const killedIds = ptys
      .filter((pty) => vi.mocked(pty.kill).mock.calls.length > 0)
      .map((pty) => sessionIdByPid.get(pty.pid));
    expect(killedIds).toEqual(["terminal-2"]);
  });

  it("refuses to reveal a terminal that is no longer live", async () => {
    const service = new IntegratedTerminalService({
      loadNodePty: async () => ({
        spawn: vi.fn(() => fakePty()) as unknown as typeof import("node-pty").spawn,
      }),
    });

    // The quit dialog can sit open long after its snapshot was taken, so a
    // listed shell may already have exited. Revealing anyway made the renderer
    // open a panel for a session-less thread, which spawned a brand-new shell.
    expect(service.revealSession("terminal-gone")).toBeUndefined();
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

  it("closes the pty master and awaits shell exit during shutdown", async () => {
    const disposable = { dispose: vi.fn() };
    const shutdownExitDisposable = { dispose: vi.fn() };
    const exitListeners: Array<(event: { exitCode: number }) => void> = [];
    const pty = fakePty({
      onData: vi.fn(() => disposable),
      onExit: vi.fn((listener) => {
        exitListeners.push(listener);
        return exitListeners.length === 1
          ? disposable
          : shutdownExitDisposable;
      }),
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

    const disposing = service.dispose();
    let disposed = false;
    void disposing.then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposable.dispose).toHaveBeenCalledTimes(2);
    expect((pty as TestPty).destroy).toHaveBeenCalledTimes(1);
    expect(pty.kill).not.toHaveBeenCalled();
    expect(disposed).toBe(false);
    expect(service.getQuitSnapshot()).toEqual({
      count: 0,
      sessionIds: [],
      threads: [],
    });

    exitListeners[1]?.({ exitCode: 0 });
    await disposing;

    expect(disposed).toBe(true);
    expect(shutdownExitDisposable.dispose).toHaveBeenCalledTimes(1);
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

type TestPty = IPty & {
  destroy: ReturnType<typeof vi.fn>;
};

function fakePty(overrides: Partial<IPty> = {}): TestPty {
  return {
    pid: 123,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    clear: vi.fn(),
    destroy: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    pause: vi.fn(),
    resume: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
    ...overrides,
  } as TestPty;
}
