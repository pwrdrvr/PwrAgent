import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTemporaryTestDirectory } from "../testing/test-harness.js";
import { loadLocalEnv } from "../testing/load-local-env.js";

const tempEnvKeys = ["XAI_API_KEY", "GROK_MODEL"];

afterEach(() => {
  for (const key of tempEnvKeys) {
    delete process.env[key];
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

  it("throws a helpful error for malformed env lines", async () => {
    const temp = await createTemporaryTestDirectory();
    const envPath = path.join(temp.path, ".env.local");
    await fs.writeFile(envPath, "XAI_API_KEY\n");

    expect(() => loadLocalEnv({ envPath })).toThrow(`Invalid env line 1 in ${envPath}`);

    await temp.cleanup();
  });
});
