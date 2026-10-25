import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpStdioLaunchError,
  buildStdioServerEnvironment,
  describeStdioStartFailure,
  maskSecrets,
  normalizeStdioLaunchInput,
  resolveStdioExecutable,
  resolveStdioLaunch,
} from "../mcp-connections/mcp-stdio-launch";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-stdio-launch-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function problemOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof McpStdioLaunchError ? error.problem : "other";
  }
  return undefined;
}

describe("normalizeStdioLaunchInput", () => {
  it("keeps arguments byte for byte and trims only names and paths", () => {
    expect(normalizeStdioLaunchInput({
      command: "  npx ",
      args: ["  padded", "$HOME", ""],
      cwd: " /home/example ",
      env: [{ name: " FIXTURE_ROOT ", secret: false, value: " spaced " }],
    })).toEqual({
      command: "npx",
      args: ["  padded", "$HOME", ""],
      cwd: "/home/example",
      env: [{ name: "FIXTURE_ROOT", secret: false, value: " spaced " }],
    });
  });

  it("refuses what it cannot run safely", () => {
    expect(problemOf(() => normalizeStdioLaunchInput({ command: "", args: [] }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({ command: "npx", args: "-y" }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({ command: "npx", args: ["a\0b"] }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({ command: "npx", args: [], cwd: "relative" }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({
      command: "npx", args: [], env: [{ name: "1BAD", secret: false, value: "x" }],
    }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({
      command: "npx", args: [], env: [
        { name: "TWICE", secret: false, value: "a" },
        { name: "TWICE", secret: false, value: "b" },
      ],
    }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({
      command: "npx", args: [], env: [{ name: "PLAIN", secret: false }],
    }))).toBe("invalid");
    expect(problemOf(() => normalizeStdioLaunchInput({
      command: "npx", args: Array.from({ length: 129 }, () => "x"),
    }))).toBe("invalid");
  });
});

describe.skipIf(process.platform === "win32")("resolveStdioExecutable", () => {
  it("resolves a bare name on the given PATH once, to an absolute path", async () => {
    const directory = temporaryDirectory();
    const program = path.join(directory, "fixture-server");
    fs.writeFileSync(program, "#!/bin/sh\n", { mode: 0o755 });
    await expect(resolveStdioExecutable("fixture-server", { PATH: directory })).resolves.toBe(program);
    await expect(resolveStdioExecutable(program, { PATH: "" })).resolves.toBe(program);
  });

  it("names a missing program, a folder, a file it may not run, and a relative path", async () => {
    const directory = temporaryDirectory();
    const plain = path.join(directory, "not-executable");
    fs.writeFileSync(plain, "data", { mode: 0o644 });
    await expect(resolveStdioExecutable("no-such-program", { PATH: directory }))
      .rejects.toMatchObject({ problem: "not_found" });
    await expect(resolveStdioExecutable(path.join(directory, "gone"), {}))
      .rejects.toMatchObject({ problem: "not_found" });
    await expect(resolveStdioExecutable(directory, {}))
      .rejects.toMatchObject({ problem: "not_executable" });
    await expect(resolveStdioExecutable(plain, {}))
      .rejects.toMatchObject({ problem: "not_executable" });
    await expect(resolveStdioExecutable("bin/server", {}))
      .rejects.toMatchObject({ problem: "invalid" });
  });
});

describe("buildStdioServerEnvironment", () => {
  it("passes only the allowlist, the login-shell PATH and the connection's variables", () => {
    const env = buildStdioServerEnvironment({
      processEnv: {
        HOME: "/home/example",
        LANG: "en_US.UTF-8",
        PATH: "/app/only/path",
        AWS_SECRET_ACCESS_KEY: "inherited",
        ELECTRON_RUN_AS_NODE: "1",
        SHELL: "() { echo exported function; }",
      },
      loginShellPath: "/usr/local/bin:/usr/bin",
      command: "/opt/fixture/bin/server",
      variables: { FIXTURE_TOKEN: "value", HOME: "/override" },
      platform: "darwin",
    });
    expect(env).toEqual({
      HOME: "/override",
      LANG: "en_US.UTF-8",
      PATH: "/opt/fixture/bin:/usr/local/bin:/usr/bin",
      FIXTURE_TOKEN: "value",
    });
  });

  it("replaces a Windows variable whatever its case", () => {
    const env = buildStdioServerEnvironment({
      processEnv: { Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" },
      command: "C:\\Tools\\server.exe",
      variables: { temp: "D:\\Scratch" },
      platform: "win32",
    });
    expect(env.temp).toBe("D:\\Scratch");
    expect(env.TEMP).toBeUndefined();
    expect(env.SYSTEMROOT ?? env.SystemRoot).toBe("C:\\Windows");
  });
});

describe("secrets in output", () => {
  it("masks every stored value, longest first, and leaves short values alone", () => {
    expect(maskSecrets("token abcdef and abcdefgh and ab", ["abcdef", "abcdefgh", "ab"]))
      .toBe("token •••• and •••• and ab");
  });

  it("refuses to start when a stored secret is missing, rather than starting without it", () => {
    expect(problemOf(() => resolveStdioLaunch({
      launch: { command: "/bin/true", args: [], env: [{ name: "FIXTURE_TOKEN", secret: true }] },
      secretValues: {},
      processEnv: {},
    }))).toBe("secret_unavailable");
    const resolved = resolveStdioLaunch({
      launch: { command: "/bin/true", args: [], env: [{ name: "FIXTURE_TOKEN", secret: true }] },
      secretValues: { FIXTURE_TOKEN: "fixture-secret" },
      processEnv: {},
    });
    expect(resolved.env.FIXTURE_TOKEN).toBe("fixture-secret");
    expect(resolved.secrets).toEqual(["fixture-secret"]);
    expect(resolved.cwd).toBe(os.homedir());
  });

  it("maps spawn errors to what the operator can fix", () => {
    const base = { displayName: "Fixture", command: "/opt/fixture/bin/server", timedOut: false };
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect(describeStdioStartFailure({ ...base, error: errno("ENOENT") }).problem).toBe("not_found");
    expect(describeStdioStartFailure({ ...base, error: errno("EACCES") }).problem).toBe("not_executable");
    expect(describeStdioStartFailure({ ...base, error: new Error("x"), timedOut: true }).problem).toBe("no_handshake");
  });
});

describe("McpStdioSecretVault", () => {
  function store() {
    let value: string | undefined;
    return {
      resolveMcpStdioConnectionSecrets: vi.fn(async () => value),
      saveMcpStdioConnectionSecrets: vi.fn(async (next: string) => {
        value = next;
      }),
      clearMcpStdioConnectionSecrets: vi.fn(async () => {
        value = undefined;
      }),
      set: (next: string | undefined) => {
        value = next;
      },
    };
  }

  it("keeps each connection's values apart and clears the slot when the last goes", async () => {
    const settings = store();
    const vault = new McpStdioSecretVault({ settings });
    await vault.write("a", { TOKEN: "one" });
    await vault.write("b", { TOKEN: "two" });
    expect(await vault.read("a")).toEqual({ TOKEN: "one" });
    await vault.delete("a");
    expect(await vault.read("a")).toEqual({});
    expect(await vault.read("b")).toEqual({ TOKEN: "two" });
    await vault.delete("b");
    expect(settings.clearMcpStdioConnectionSecrets).toHaveBeenCalled();
  });

  it("fails a write that storage silently dropped, and a slot it cannot parse", async () => {
    const settings = store();
    settings.saveMcpStdioConnectionSecrets.mockImplementation(async () => undefined);
    const vault = new McpStdioSecretVault({ settings });
    await expect(vault.write("a", { TOKEN: "one" })).rejects.toThrow("could not save");
    settings.set("not json");
    await expect(vault.read("a")).rejects.toThrow("unreadable");
  });
});
