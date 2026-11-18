import { execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

// A real executable posing as the login shell lets the parent control native
// retirement over stdin, without loading the operator's interactive dotfiles.
it.skipIf(process.platform === "win32").each(["active-shell", "inherited-stdio"])("native retirement oracle: %s", async (mode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shell-native-"));
  const shell = path.join(root, "shell");
  const release = path.join(root, "release");
  const holder = `
    const fs = require("node:fs");
    const watcher = fs.watch(${JSON.stringify(root)}, () => {
      if (fs.existsSync(${JSON.stringify(release)})) watcher.close();
    });
    if (fs.existsSync(${JSON.stringify(release)})) watcher.close();
    process.send("ready");
  `;
  fs.writeFileSync(shell, `#!${process.execPath}
    const { spawn } = require("node:child_process");
    process.stdout.write("ready\\n");
    process.stdin.once("data", () => {
      process.stdout.write("__PWRAGENT_LOGIN_SHELL_ENV_START__\\nHYDRATED=native\\n__PWRAGENT_LOGIN_SHELL_ENV_END__\\n");
      if (${JSON.stringify(mode)} === "inherited-stdio") {
        const child = spawn(${JSON.stringify(process.execPath)}, ["-e", ${JSON.stringify(holder)}], { stdio: ["ignore", 1, 2, "ipc"] });
        child.once("message", () => process.exit(0));
      } else process.exit(0);
    });
  `, { mode: 0o755 });
  const configPath = path.join(root, "config.toml");
  const configStore = new DesktopConfigStore({ configPath });
  const service = new DesktopSettingsService({
    configPath, configStore, secretStore: new MemoryDesktopSecretStore(),
    codexHome: path.join(root, "codex"), env: { HOME: root, SHELL: shell, PATH: "" },
  });
  const children: ChildProcess[] = [];
  const retirements: Promise<unknown>[] = [];
  const original = vi.mocked(execFile).getMockImplementation()!;
  vi.mocked(execFile).mockImplementation((...args: Parameters<typeof execFile>) => {
    const child = original(...args);
    children.push(child);
    retirements.push(once(child, "close"));
    return child;
  });
  const requests: Promise<NodeJS.ProcessEnv>[] = [];
  try {
    requests.push(service.resolveCodexSpawnEnvAsync(), service.resolveTerminalSpawnEnvAsync());
    expect(children).toHaveLength(2);
    await Promise.all(children.map(child => once(child.stdout!, "data")));
    let closed = false;
    const closing = service.closeCommandDiscovery().then(() => { closed = true; });
    const secondClose = service.closeCommandDiscovery();
    await drain();
    for (const child of children) {
      expect(child.exitCode).toBeNull();
      expect(child.stdout!.destroyed).toBe(false);
      expect(child.killed).toBe(false);
    }
    expect.soft(closed).toBe(false);
    if (mode === "inherited-stdio") {
      const exits = children.map(child => once(child, "exit"));
      for (const child of children) child.stdin!.end("release\n");
      await Promise.all(exits);
      await drain();
      expect(children.every(child => child.exitCode === 0)).toBe(true);
      expect(children.every(child => !child.stdout!.destroyed)).toBe(true);
      expect.soft(closed).toBe(false);
      fs.writeFileSync(release, "release");
    } else {
      for (const child of children) child.stdin!.end("release\n");
    }
    await Promise.all([closing, secondClose]);
    expect(children.every(child => child.stdout!.destroyed && child.stderr!.destroyed)).toBe(true);
    expect((await Promise.all(requests)).every(env => env.HYDRATED === "native")).toBe(true);
    await Promise.all([service.resolveCodexSpawnEnvAsync(), service.resolveTerminalSpawnEnvAsync()]);
    expect(children).toHaveLength(2);
  } finally {
    // Release fixtures cooperatively even on a red pre-fix assertion. No tree
    // kill, unref, fake clock, timeout override or early callback can pass this.
    fs.writeFileSync(release, "release");
    for (const child of children) {
      if (!child.stdin?.destroyed && !child.stdin?.writableEnded) child.stdin?.end("release\n");
    }
    await Promise.all(requests);
    await Promise.all(retirements);
    await service.closeCommandDiscovery();
    configStore.dispose();
    vi.mocked(execFile).mockImplementation(original);
    vi.mocked(execFile).mockClear();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
