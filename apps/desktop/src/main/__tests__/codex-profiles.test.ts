import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverCodexAuthProfiles,
  resolveCodexHomeForProfile,
} from "../settings/codex-profiles";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-codex-profiles-"));
  tempRoots.push(root);
  return root;
}

describe("Codex auth profile discovery", () => {
  it("lists the system default and named CODEX_HOME profile directories", () => {
    const root = createTempRoot();
    const codexHome = path.join(root, "codex");
    const profileHome = path.join(codexHome, "profiles", "work");
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(path.join(profileHome, "auth.json"), "{}", "utf8");
    fs.writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");

    const discovery = discoverCodexAuthProfiles({
      configuredProfile: "work",
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });

    expect(discovery.profileRoot).toBe(path.join(codexHome, "profiles"));
    expect(discovery.effectiveCodexHome).toBe(profileHome);
    expect(discovery.profiles).toMatchObject([
      {
        name: "",
        displayName: "System default",
        codexHome,
        selected: false,
        hasConfigFile: true,
      },
      {
        name: "work",
        displayName: "work",
        codexHome: profileHome,
        selected: true,
        hasAuthFile: true,
      },
    ]);
  });

  it("adds the configured profile even when the directory does not exist yet", () => {
    const root = createTempRoot();
    const codexHome = path.join(root, "codex");

    const discovery = discoverCodexAuthProfiles({
      configuredProfile: "personal",
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });

    expect(discovery.profiles.at(-1)).toMatchObject({
      name: "personal",
      source: "config",
      exists: false,
      selected: true,
    });
  });

  it("rejects invalid profile names before resolving a CODEX_HOME override", () => {
    const root = createTempRoot();
    expect(
      resolveCodexHomeForProfile("../work", {
        env: { CODEX_HOME: path.join(root, "codex") } as NodeJS.ProcessEnv,
      }),
    ).toBeUndefined();
  });
});
