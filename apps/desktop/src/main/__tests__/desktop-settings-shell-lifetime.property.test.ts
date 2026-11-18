import { ChildProcess, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: vi.fn(),
}));

const marked = "__PWRAGENT_LOGIN_SHELL_ENV_START__\nPATH=/shell/bin\nHYDRATED=yes\nELECTRON_RENDERER_URL=http://fixture.invalid\n__PWRAGENT_LOGIN_SHELL_ENV_END__\n";
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
type Probe = { child: ChildProcess; callback(error: Error | null, stdout: string, stderr: string): void };
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-shell-model-"));
  roots.push(root);
  const configPath = path.join(root, "config.toml");
  const configStore = new DesktopConfigStore({ configPath });
  const probes: Probe[] = [];
  vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
    const child = new ChildProcess();
    probes.push({ child, callback: args[3] as Probe["callback"] });
    return child;
  });
  let now = 0;
  const service = new DesktopSettingsService({
    env: { HOME: root, SHELL: "/fixture/shell", PATH: "/parent/bin", ELECTRON_RENDERER_URL: "http://parent.invalid" },
    configPath, configStore, codexHome: path.join(root, "codex"),
    secretStore: new MemoryDesktopSecretStore(), now: () => now,
  });
  return { service, configStore, probes, expire: () => { now += 86_400_000; } };
}

// Model: each kind admits at most one hydration; close removes admission and
// joins every admitted child through close, independently of callback or exit.
// Exhaust the order of the two independent retirements and each failure mode.
it.skipIf(process.platform === "win32").each([
  ["codex", false], ["terminal", false], ["codex", true], ["terminal", true],
] as const)("joins concurrent hydration through stdio close (%s first, failure=%s)", async (first, failure) => {
  const { service, configStore, probes, expire } = fixture();
  const requests: Promise<NodeJS.ProcessEnv>[] = [];
  const read = (kind: string) => kind === "codex"
    ? service.resolveCodexSpawnEnvAsync() : service.resolveTerminalSpawnEnvAsync();
  try {
    expect(probes).toHaveLength(0);
    requests.push(read("codex"), read("terminal"), read("codex"), read("terminal"));
    expect(probes).toHaveLength(2);
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 2_500, maxBuffer: 1024 * 1024 });
      expect(call[2]).not.toHaveProperty("signal");
      expect((call[2] as { env: NodeJS.ProcessEnv }).env.ELECTRON_RENDERER_URL).toBeUndefined();
    }
    let closed = false;
    const closing = service.closeCommandDiscovery().then(() => { closed = true; });
    expect(service.closeCommandDiscovery()).toBe(service.closeCommandDiscovery());
    await drain();
    expect(closed).toBe(false);
    requests.push(read("codex"), read("terminal"));
    const order = first === "codex" ? [probes[0]!, probes[1]!] : [probes[1]!, probes[0]!];
    for (const probe of order) {
      probe.callback(failure ? new Error("controlled shell failure") : null, failure ? "" : marked, "");
      probe.child.emit("exit", failure ? 1 : 0, null);
      await drain();
      expect(closed).toBe(false);
      expect(probes).toHaveLength(2);
      probe.child.emit("close", failure ? 1 : 0, null);
    }
    await closing;
    const values = await Promise.all(requests);
    expect(values[0]).toBe(values[2]);
    expect(values[1]).toBe(values[3]);
    expect(values[0]).toBe(values[4]);
    expect(values[1]).toBe(values[5]);
    for (const env of values) {
      expect(env.HYDRATED).toBe(failure ? undefined : "yes");
      expect(env.ELECTRON_RENDERER_URL).toBeUndefined();
    }
    expire();
    await Promise.all([read("codex"), read("terminal")]);
    expect(probes).toHaveLength(2);
  } finally {
    // Retire all admitted fixtures even when the pre-fix assertion fails.
    for (const probe of probes) {
      probe.callback(null, marked, "");
      probe.child.emit("close", 0, null);
    }
    await service.closeCommandDiscovery();
    await Promise.all(requests);
    configStore.dispose();
  }
});

it.skipIf(process.platform === "win32")("stops admission before first use, including synchronous hydration", async () => {
  const { service, configStore, probes } = fixture();
  const requests: Promise<NodeJS.ProcessEnv>[] = [];
  try {
    await service.closeCommandDiscovery();
    service.resolveCodexSpawnEnv();
    requests.push(service.resolveCodexSpawnEnvAsync(), service.resolveTerminalSpawnEnvAsync());
    expect(probes).toHaveLength(0);
    await Promise.all(requests);
  } finally {
    for (const probe of probes) { probe.callback(null, marked, ""); probe.child.emit("close", 0, null); }
    await service.closeCommandDiscovery();
    await Promise.all(requests);
    configStore.dispose();
  }
});

it.skipIf(process.platform === "win32").each(["error", "missing-markers"])("stops fallback at the completion boundary (%s)", async (failure) => {
  const { service, configStore, probes } = fixture();
  const pending = service.resolveCodexSpawnEnvAsync();
  try {
    const probe = probes[0]!;
    probe.callback(failure === "error" ? new Error("controlled failure") : null, "no markers", "");
    probe.child.emit("close", 1, null);
    // Close in the same native dispatch before the await continuation can
    // authorize a fallback, including when callback and close already fired.
    const closing = service.closeCommandDiscovery();
    await drain();
    expect(probes).toHaveLength(1);
    await closing;
    await pending;
  } finally {
    for (const probe of probes) { probe.callback(null, marked, ""); probe.child.emit("close", 0, null); }
    await service.closeCommandDiscovery();
    await pending;
    configStore.dispose();
  }
});

it.skipIf(process.platform === "win32")("preserves first use, fallback, successful caches and Codex TTL refresh", async () => {
  const { service, configStore, probes, expire } = fixture();
  try {
    const first = service.resolveCodexSpawnEnvAsync();
    probes[0]!.callback(new Error("first shell unavailable"), "", "");
    probes[0]!.child.emit("close", 1, null);
    await drain();
    expect(probes).toHaveLength(2);
    probes[1]!.callback(null, marked, "");
    probes[1]!.child.emit("close", 0, null);
    expect((await first).HYDRATED).toBe("yes");
    await service.resolveCodexSpawnEnvAsync();
    expect(probes).toHaveLength(2);
    const terminal = service.resolveTerminalSpawnEnvAsync();
    probes[2]!.callback(null, marked, "");
    probes[2]!.child.emit("close", 0, null);
    await terminal;
    expire();
    const refresh = service.resolveCodexSpawnEnvAsync();
    expect(probes).toHaveLength(4);
    probes[3]!.callback(null, marked, "");
    probes[3]!.child.emit("close", 0, null);
    await refresh;
    await service.resolveTerminalSpawnEnvAsync();
    expect(probes).toHaveLength(4);
  } finally {
    for (const probe of probes) { probe.callback(null, marked, ""); probe.child.emit("close", 0, null); }
    await service.closeCommandDiscovery();
    configStore.dispose();
  }
});
