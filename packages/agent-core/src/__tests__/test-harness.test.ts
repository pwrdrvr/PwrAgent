import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";
import {
  defaultGrokAppServerConfigPaths,
  defaultLocalEnvPath,
  loadGrokAppServerConfig,
  loadLocalEnv,
} from "../testing/load-local-env.js";

const originalHome = process.env.HOME;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const tempEnvKeys = ["XAI_API_KEY", "GROK_MODEL", "XAI_BASE_URL"];

afterEach(() => {
  for (const key of tempEnvKeys) {
    delete process.env[key];
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
});

describe("test harness helpers", () => {
  it("creates and removes a temporary test directory", async () => {
    const temp = await createTemporaryTestDirectory();
    await fs.writeFile(path.join(temp.path, "marker.txt"), "ok");
    await expect(fs.stat(path.join(temp.path, "marker.txt"))).resolves.toBeDefined();

    await temp.cleanup();

    await expect(fs.stat(temp.path)).rejects.toThrow();
  });

  it("skips local env loading when the file is missing", () => {
    const result = loadLocalEnv({
      envPath: "/tmp/does-not-exist-agent-core.env",
    });

    expect(result.loaded).toBe(false);
    expect(result.skippedReason).toBe("missing");
    expect(result.entries).toEqual([]);
  });

  it("prefers the workspace root env file over the package-local env file", async () => {
    const temp = await createTemporaryTestDirectory();
    const currentDir = path.join(temp.path, "packages/agent-core/src/testing");
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(path.join(temp.path, ".env.local"), "XAI_API_KEY=root-key\n");
    await fs.writeFile(
      path.join(temp.path, "packages/agent-core/.env.local"),
      "XAI_API_KEY=package-key\n"
    );

    expect(defaultLocalEnvPath({ currentDir })).toBe(
      path.join(temp.path, ".env.local")
    );

    await temp.cleanup();
  });

  it("falls back to the package-local env file when the workspace root env file is missing", async () => {
    const temp = await createTemporaryTestDirectory();
    const currentDir = path.join(temp.path, "packages/agent-core/src/testing");
    await fs.mkdir(currentDir, { recursive: true });
    await fs.writeFile(
      path.join(temp.path, "packages/agent-core/.env.local"),
      "XAI_API_KEY=package-key\n"
    );

    expect(defaultLocalEnvPath({ currentDir })).toBe(
      path.join(temp.path, "packages/agent-core/.env.local")
    );

    await temp.cleanup();
  });

  it("loads values from a local env file", async () => {
    const temp = await createTemporaryTestDirectory();
    const envPath = path.join(temp.path, ".env.local");
    await fs.writeFile(envPath, "XAI_API_KEY=test-key\nGROK_MODEL=grok-4.20-reasoning\n");

    const result = loadLocalEnv({ envPath });

    expect(result.loaded).toBe(true);
    expect(result.entries).toEqual(["XAI_API_KEY", "GROK_MODEL"]);
    expect(process.env.XAI_API_KEY).toBe("test-key");
    expect(process.env.GROK_MODEL).toBe("grok-4.20-reasoning");

    await temp.cleanup();
  });

  it("loads Grok app-server config from the XDG config directory", async () => {
    const temp = await createTemporaryTestDirectory();
    process.env.HOME = temp.path;
    delete process.env.XDG_CONFIG_HOME;
    const [configPath] = defaultGrokAppServerConfigPaths({ homeDir: temp.path });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      "XAI_API_KEY=config-key\nGROK_MODEL=grok-4.20-fast\nXAI_BASE_URL=https://api.example.test/v1\n",
    );

    const result = loadGrokAppServerConfig({ homeDir: temp.path });

    expect(result).toEqual({
      path: configPath,
      loaded: true,
      entries: ["XAI_API_KEY", "GROK_MODEL", "XAI_BASE_URL"],
    });
    expect(process.env.XAI_API_KEY).toBe("config-key");
    expect(process.env.GROK_MODEL).toBe("grok-4.20-fast");
    expect(process.env.XAI_BASE_URL).toBe("https://api.example.test/v1");

    await temp.cleanup();
  });

  it("does not override existing env values with Grok app-server config defaults", async () => {
    const temp = await createTemporaryTestDirectory();
    process.env.HOME = temp.path;
    delete process.env.XDG_CONFIG_HOME;
    process.env.XAI_API_KEY = "existing-key";
    const [configPath] = defaultGrokAppServerConfigPaths({ homeDir: temp.path });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, "XAI_API_KEY=config-key\nGROK_MODEL=grok-4.20-fast\n");

    const result = loadGrokAppServerConfig({ homeDir: temp.path, override: false });

    expect(result.loaded).toBe(true);
    expect(process.env.XAI_API_KEY).toBe("existing-key");
    expect(process.env.GROK_MODEL).toBe("grok-4.20-fast");

    await temp.cleanup();
  });

  it("throws a helpful error for malformed env lines", async () => {
    const temp = await createTemporaryTestDirectory();
    const envPath = path.join(temp.path, ".env.local");
    await fs.writeFile(envPath, "XAI_API_KEY\n");

    expect(() => loadLocalEnv({ envPath })).toThrow(`Invalid env line 1 in ${envPath}`);

    await temp.cleanup();
  });
});
