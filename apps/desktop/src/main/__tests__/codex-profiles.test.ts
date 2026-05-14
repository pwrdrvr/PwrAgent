import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCodexAuthProfile,
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

  it("reads the account email from Codex auth tokens when present", () => {
    const root = createTempRoot();
    const codexHome = path.join(root, "codex");
    const profileHome = path.join(codexHome, "profiles", "work");
    fs.mkdirSync(profileHome, { recursive: true });
    fs.writeFileSync(
      path.join(profileHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          id_token: createUnsignedJwt({ email: "work@example.com" }),
        },
      }),
      "utf8",
    );

    const discovery = discoverCodexAuthProfiles({
      configuredProfile: "work",
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });

    expect(discovery.profiles[1]).toMatchObject({
      name: "work",
      accountEmail: "work@example.com",
    });
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

  it("creates named Codex auth profile directories", () => {
    const root = createTempRoot();
    const codexHome = path.join(root, "codex");

    const created = createCodexAuthProfile("work", {
      env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
    });

    expect(created).toEqual({
      profile: "work",
      codexHome: path.join(codexHome, "profiles", "work"),
      created: true,
    });
    expect(fs.statSync(created.codexHome).isDirectory()).toBe(true);

    expect(
      createCodexAuthProfile("work", {
        env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
      }).created,
    ).toBe(false);
  });
});

function createUnsignedJwt(payload: Record<string, unknown>): string {
  return [
    encodeJwtPart({ alg: "none", typ: "JWT" }),
    encodeJwtPart(payload),
    "",
  ].join(".");
}

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
