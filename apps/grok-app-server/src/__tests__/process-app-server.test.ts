import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProcessAppServer } from "../process-app-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("process app-server config", () => {
  it("loads the explicit repository env path into the child environment", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-process-"),
    );
    temporaryDirectories.push(tempRoot);
    const envPath = path.join(tempRoot, ".env.local");
    const env = {
      PWRAGENT_GROK_LOCAL_ENV_PATH: envPath,
      PWRAGENT_GROK_PROFILE_STATE_ROOT: path.join(tempRoot, "state"),
      PWRAGENT_HOME: path.join(tempRoot, "pwragent-home"),
    } as NodeJS.ProcessEnv;
    await fs.writeFile(
      envPath,
      "XAI_API_KEY=project-key\nGROK_MODEL=grok-4.20-reasoning\n",
    );

    const server = createProcessAppServer(env);

    expect(server.shouldShutdown()).toBe(false);
    expect(env.XAI_API_KEY).toBe("project-key");
    expect(env.GROK_MODEL).toBe("grok-4.20-reasoning");
  });

  it("keeps a deliberately passed API key ahead of repository env", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-grok-process-"),
    );
    temporaryDirectories.push(tempRoot);
    const envPath = path.join(tempRoot, ".env.local");
    const env = {
      PWRAGENT_GROK_LOCAL_ENV_PATH: envPath,
      PWRAGENT_GROK_PROFILE_STATE_ROOT: path.join(tempRoot, "state"),
      PWRAGENT_HOME: path.join(tempRoot, "pwragent-home"),
      XAI_API_KEY: "keychain-key",
    } as NodeJS.ProcessEnv;
    await fs.writeFile(envPath, "XAI_API_KEY=project-key\n");

    createProcessAppServer(env);

    expect(env.XAI_API_KEY).toBe("keychain-key");
  });
});
