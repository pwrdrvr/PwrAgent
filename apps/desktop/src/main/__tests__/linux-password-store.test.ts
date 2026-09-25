import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyRememberedLinuxPasswordStore,
  linuxPasswordStorePath,
  parseDbusNameList,
  probeSecretServices,
  relaunchForLinuxSecretStore,
  type CommandExec,
  type SecretServiceProbe,
} from "../linux-password-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "pwragent-secret-store-"));
  roots.push(root);
  return root;
}

function remember(pwragentRoot: string, store: string): void {
  writeFileSync(linuxPasswordStorePath(pwragentRoot), `${store}\n`);
}

const secretsProbe: SecretServiceProbe = {
  status: "ok",
  owned: ["org.freedesktop.secrets"],
  activatable: ["org.kde.kwalletd6"],
};

describe("parseDbusNameList", () => {
  it("reads busctl, dbus-send, and gdbus payloads", () => {
    expect(parseDbusNameList('as 2 "org.freedesktop.DBus" "org.freedesktop.secrets"')).toEqual([
      "org.freedesktop.DBus",
      "org.freedesktop.secrets",
    ]);
    expect(parseDbusNameList(`
      array [
         string "org.kde.kwalletd6"
      ]
    `)).toEqual(["org.kde.kwalletd6"]);
    expect(parseDbusNameList("(['org.freedesktop.secrets', 'org.kde.kwalletd5'],)")).toEqual([
      "org.freedesktop.secrets",
      "org.kde.kwalletd5",
    ]);
  });
});

describe("probeSecretServices", () => {
  it("uses the first installed client and keeps owned ahead of activatable", () => {
    const exec = vi.fn<CommandExec>((command) => {
      if (command === "busctl") {
        return { missing: true };
      }
      return {
        status: 0,
        stdout: command === "dbus-send"
          ? 'string "org.kde.kwalletd6"'
          : "",
      };
    });
    exec.mockImplementation((command, args) => {
      if (command !== "dbus-send") return { missing: true };
      const activatable = args.includes("org.freedesktop.DBus.ListActivatableNames");
      return {
        status: 0,
        stdout: activatable
          ? 'string "org.freedesktop.secrets"'
          : 'string "org.kde.kwalletd6"',
      };
    });
    expect(probeSecretServices(exec)).toEqual({
      status: "ok",
      owned: ["org.kde.kwalletd6"],
      activatable: ["org.freedesktop.secrets"],
    });
    expect(exec.mock.calls.some(([command]) => command === "gdbus")).toBe(false);
  });

  it("reports a failed bus call separately from a missing client", () => {
    const exec: CommandExec = (command) => command === "busctl"
      ? { status: 1, stdout: "", stderr: "Failed to connect" }
      : { missing: true };
    expect(probeSecretServices(exec)).toEqual({
      status: "unavailable",
      reason: "busctl ListNames exited 1",
    });
  });

  it("reports when no dbus client is installed", () => {
    const exec: CommandExec = () => ({ missing: true });
    expect(probeSecretServices(exec)).toEqual({
      status: "unavailable",
      reason: "no dbus client (busctl, dbus-send, gdbus)",
    });
  });
});

describe("applyRememberedLinuxPasswordStore", () => {
  it("appends an env override and ignores a remembered file", () => {
    const pwragentRoot = tempDir();
    remember(pwragentRoot, "kwallet6");
    const appendSwitch = vi.fn();
    expect(applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: { PWRAGENT_LINUX_PASSWORD_STORE: "gnome-libsecret" },
      pwragentRoot,
      appendSwitch,
    })).toBe("gnome-libsecret");
    expect(appendSwitch).toHaveBeenCalledWith("gnome-libsecret");
  });

  it("still uses the remembered store when the override is auto", () => {
    const pwragentRoot = tempDir();
    remember(pwragentRoot, "gnome-libsecret");
    const appendSwitch = vi.fn();
    expect(applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: { PWRAGENT_LINUX_PASSWORD_STORE: "auto" },
      pwragentRoot,
      appendSwitch,
    })).toBe("gnome-libsecret");
  });

  it("appends the remembered store when the operator did not choose one", () => {
    const pwragentRoot = tempDir();
    remember(pwragentRoot, "kwallet5");
    const appendSwitch = vi.fn();
    expect(applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent", "--profile", "default"],
      env: {},
      pwragentRoot,
      appendSwitch,
    })).toBe("kwallet5");
  });

  it("does not append when argv, basic opt-out, or another platform already decided", () => {
    const pwragentRoot = tempDir();
    remember(pwragentRoot, "gnome-libsecret");
    const appendSwitch = vi.fn();
    expect(applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent", "--password-store=kwallet6"],
      env: {},
      pwragentRoot,
      appendSwitch,
    })).toBeUndefined();
    expect(applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: { PWRAGENT_LINUX_PASSWORD_STORE: "basic" },
      pwragentRoot,
      appendSwitch,
    })).toBeUndefined();
    expect(applyRememberedLinuxPasswordStore({
      platform: "darwin",
      argv: ["pwragent"],
      env: { PWRAGENT_LINUX_PASSWORD_STORE: "gnome-libsecret" },
      pwragentRoot,
      appendSwitch,
    })).toBeUndefined();
    expect(appendSwitch).not.toHaveBeenCalled();
  });
});

describe("relaunchForLinuxSecretStore", () => {
  function relaunchWith(
    overrides: Partial<Parameters<typeof relaunchForLinuxSecretStore>[0]>,
  ) {
    const pwragentRoot = tempDir();
    const relaunch = vi.fn();
    const exit = vi.fn();
    const info = vi.fn();
    const warn = vi.fn();
    const exited = relaunchForLinuxSecretStore({
      platform: "linux",
      argv: ["/usr/bin/pwragent", "--profile", "default"],
      env: {},
      pwragentRoot,
      selectedStore: undefined,
      encryptionAvailable: false,
      backend: "basic_text",
      probe: secretsProbe,
      relaunch,
      exit,
      info,
      warn,
      ...overrides,
    });
    return { exited, relaunch, exit, info, warn, pwragentRoot };
  }

  it("relaunches on basic_text and prefers an owned service over an activatable one", () => {
    const result = relaunchWith({
      probe: {
        status: "ok",
        owned: ["org.kde.kwalletd6"],
        activatable: ["org.freedesktop.secrets"],
      },
    });
    expect(result.exited).toBe(true);
    expect(result.relaunch).toHaveBeenCalledWith([
      "--profile",
      "default",
      "--password-store=kwallet6",
    ]);
    expect(result.exit).toHaveBeenCalledWith(0);
    expect(readFileSync(linuxPasswordStorePath(result.pwragentRoot), "utf8")).toBe("kwallet6\n");
  });

  it("uses an activatable secret service when nothing is running", () => {
    const result = relaunchWith({
      probe: {
        status: "ok",
        owned: ["org.freedesktop.DBus"],
        activatable: ["org.freedesktop.secrets"],
      },
    });
    expect(result.relaunch).toHaveBeenCalledWith([
      "--profile",
      "default",
      "--password-store=gnome-libsecret",
    ]);
  });

  it("creates the preference beneath a new PwrAgent root", () => {
    const pwragentRoot = join(tempDir(), "isolated", "pwragent");
    const result = relaunchWith({ pwragentRoot });
    expect(result.exited).toBe(true);
    expect(readFileSync(linuxPasswordStorePath(pwragentRoot), "utf8"))
      .toBe("gnome-libsecret\n");
  });

  it("preserves a remembered KWallet selection when unlocking fails", () => {
    const pwragentRoot = tempDir();
    remember(pwragentRoot, "kwallet6");
    const argv = ["pwragent"];
    const appendSwitch = vi.fn();
    const selectedStore = applyRememberedLinuxPasswordStore({
      platform: "linux",
      argv,
      env: {},
      pwragentRoot,
      appendSwitch,
    });
    expect(appendSwitch).toHaveBeenCalledWith("kwallet6");
    const exec = vi.fn<CommandExec>();
    const result = relaunchWith({
      argv,
      pwragentRoot,
      selectedStore,
      encryptionAvailable: false,
      backend: "kwallet6",
      probe: undefined,
      exec,
    });
    expect(result.exited).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(result.relaunch).not.toHaveBeenCalled();
    expect(result.exit).not.toHaveBeenCalled();
    expect(readFileSync(linuxPasswordStorePath(pwragentRoot), "utf8"))
      .toBe("kwallet6\n");
  });

  it("leaves a usable backend alone", () => {
    const result = relaunchWith({
      encryptionAvailable: true,
      backend: "kwallet",
    });
    expect(result.exited).toBe(false);
    expect(result.relaunch).not.toHaveBeenCalled();
  });

  it("does not relaunch when the switch, opt-out, e2e, or a failed probe already covers it", () => {
    expect(relaunchWith({
      argv: ["pwragent", "--password-store=gnome-libsecret"],
    }).exited).toBe(false);
    expect(relaunchWith({
      env: { PWRAGENT_LINUX_PASSWORD_STORE: "basic" },
    }).exited).toBe(false);
    expect(relaunchWith({
      env: { PWRAGENT_E2E: "1" },
    }).exited).toBe(false);
    const failed = relaunchWith({
      probe: { status: "unavailable", reason: "busctl ListNames exited 1" },
    });
    expect(failed.exited).toBe(false);
    expect(failed.warn).toHaveBeenCalledWith(
      "linux secret service probe failed",
      { reason: "busctl ListNames exited 1" },
    );
    expect(relaunchWith({
      probe: { status: "ok", owned: [], activatable: [] },
    }).exited).toBe(false);
  });
});
