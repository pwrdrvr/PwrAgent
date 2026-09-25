import { describe, expect, it, vi } from "vitest";
import {
  argvAlreadySelectsPasswordStore,
  chromiumSelectsBasicText,
  installLinuxPasswordStore,
  selectLinuxPasswordStore,
  type DbusNameProbe,
} from "../linux-password-store";

const hyprland = {
  XDG_CURRENT_DESKTOP: "Hyprland",
  XDG_SESSION_DESKTOP: "Hyprland",
  DESKTOP_SESSION: "omarchy",
};

function names(owned: readonly string[]): DbusNameProbe {
  const set = new Set(owned);
  return (name) => set.has(name);
}

function select(
  env: NodeJS.ProcessEnv,
  owned: readonly string[] = ["org.freedesktop.secrets"],
  argv: readonly string[] = ["pwragent"],
) {
  return selectLinuxPasswordStore({
    platform: "linux",
    argv,
    env,
    nameOwned: names(owned),
  });
}

describe("argvAlreadySelectsPasswordStore", () => {
  it("sees both spellings of the switch", () => {
    expect(argvAlreadySelectsPasswordStore(["pwragent", "--password-store=gnome-libsecret"])).toBe(true);
    expect(argvAlreadySelectsPasswordStore(["pwragent", "--password-store", "kwallet6"])).toBe(true);
    expect(argvAlreadySelectsPasswordStore(["pwragent", "--profile", "default"])).toBe(false);
  });
});

describe("chromiumSelectsBasicText", () => {
  it("treats Hyprland and an empty desktop as unrecognized", () => {
    expect(chromiumSelectsBasicText(hyprland)).toBe(true);
    expect(chromiumSelectsBasicText({})).toBe(true);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "sway" })).toBe(true);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "LXQt" })).toBe(true);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "COSMIC" })).toBe(true);
  });

  it("leaves desktops Chromium already handles alone", () => {
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "GNOME" })).toBe(false);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "Hyprland:GNOME" })).toBe(false);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "KDE" })).toBe(false);
    expect(chromiumSelectsBasicText({ XDG_CURRENT_DESKTOP: "XFCE" })).toBe(false);
    expect(chromiumSelectsBasicText({ DESKTOP_SESSION: "xfce" })).toBe(false);
    expect(chromiumSelectsBasicText({ GNOME_DESKTOP_SESSION_ID: "this-is-deprecated" })).toBe(false);
    expect(chromiumSelectsBasicText({ KDE_FULL_SESSION: "true" })).toBe(false);
  });
});

describe("selectLinuxPasswordStore", () => {
  it("does nothing off Linux or when the operator already passed the switch", () => {
    expect(selectLinuxPasswordStore({
      platform: "darwin",
      argv: ["pwragent"],
      env: hyprland,
      nameOwned: names(["org.freedesktop.secrets"]),
    })).toBeUndefined();
    expect(select(hyprland, ["org.freedesktop.secrets"], [
      "pwragent",
      "--password-store=basic",
    ])).toBeUndefined();
  });

  it("uses the secret service on an unrecognized desktop", () => {
    const nameOwned = vi.fn(names(["org.freedesktop.secrets", "org.kde.kwalletd6"]));
    expect(selectLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: hyprland,
      nameOwned,
    })).toBe("gnome-libsecret");
    expect(nameOwned).toHaveBeenCalledTimes(1);
    expect(nameOwned).toHaveBeenCalledWith("org.freedesktop.secrets");
  });

  it("falls through KWallet generations when gnome-keyring is not running", () => {
    expect(select(hyprland, ["org.kde.kwalletd6"])).toBe("kwallet6");
    expect(select(hyprland, ["org.kde.kwalletd5"])).toBe("kwallet5");
    expect(select(hyprland, ["org.kde.kwalletd"])).toBe("kwallet");
    expect(select(hyprland, [])).toBeUndefined();
  });

  it("does not probe a recognized desktop", () => {
    const nameOwned = vi.fn(names(["org.freedesktop.secrets"]));
    expect(selectLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: { XDG_CURRENT_DESKTOP: "GNOME" },
      nameOwned,
    })).toBeUndefined();
    expect(nameOwned).not.toHaveBeenCalled();
  });

  it("lets the environment force a store, including opting out", () => {
    expect(select(
      { ...hyprland, PWRAGENT_LINUX_PASSWORD_STORE: "kwallet6" },
      [],
    )).toBe("kwallet6");
    expect(select(
      { XDG_CURRENT_DESKTOP: "GNOME", PWRAGENT_LINUX_PASSWORD_STORE: "gnome-libsecret" },
      [],
    )).toBe("gnome-libsecret");
    expect(select(
      { ...hyprland, PWRAGENT_LINUX_PASSWORD_STORE: "basic" },
      ["org.freedesktop.secrets"],
    )).toBeUndefined();
    expect(select(
      { ...hyprland, PWRAGENT_LINUX_PASSWORD_STORE: "auto" },
      ["org.kde.kwalletd6"],
    )).toBe("kwallet6");
  });
});

describe("installLinuxPasswordStore", () => {
  it("appends the switch only when a store was selected", () => {
    const appendSwitch = vi.fn();
    expect(installLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: hyprland,
      nameOwned: names(["org.freedesktop.secrets"]),
      appendSwitch,
    })).toBe("gnome-libsecret");
    expect(appendSwitch).toHaveBeenCalledTimes(1);
    expect(appendSwitch).toHaveBeenCalledWith("gnome-libsecret");

    appendSwitch.mockClear();
    expect(installLinuxPasswordStore({
      platform: "linux",
      argv: ["pwragent"],
      env: { XDG_CURRENT_DESKTOP: "KDE" },
      nameOwned: names(["org.kde.kwalletd6"]),
      appendSwitch,
    })).toBeUndefined();
    expect(appendSwitch).not.toHaveBeenCalled();
  });
});
