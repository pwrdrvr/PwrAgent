import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionMetadataService } from "../app-server/codex-session-metadata-service";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-session-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CodexSessionMetadataService", () => {
  it("updates the session metadata cwd for a handed-off thread", async () => {
    const codexHome = await makeTempDir();
    const threadId = "019df34d-d561-7763-b1a0-6591048e7e55";
    const sessionDir = path.join(codexHome, "sessions", "2026", "05", "04");
    const sessionPath = path.join(
      sessionDir,
      `rollout-2026-05-04T10-04-17-${threadId}.jsonl`,
    );
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      [
        JSON.stringify({
          timestamp: "2026-05-04T14:04:35.539Z",
          type: "session_meta",
          payload: {
            id: threadId,
            cwd: "/Users/huntharo/github/PwrAgnt",
          },
        }),
        JSON.stringify({
          timestamp: "2026-05-04T17:23:01.854Z",
          type: "turn_context",
          payload: {
            cwd: "/Users/huntharo/github/PwrAgnt",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await new CodexSessionMetadataService({ codexHome }).updateThreadCwd({
      cwd: "/Users/huntharo/.codex/worktrees/morgwp0f/PwrAgnt",
      threadId,
    });

    expect(result).toMatchObject({
      path: sessionPath,
      updated: true,
    });
    const [metaLine, turnContextLine] = (await readFile(sessionPath, "utf8")).trim().split("\n");
    expect(JSON.parse(metaLine!)).toMatchObject({
      payload: {
        cwd: "/Users/huntharo/.codex/worktrees/morgwp0f/PwrAgnt",
        id: threadId,
      },
      type: "session_meta",
    });
    expect(JSON.parse(turnContextLine!)).toMatchObject({
      payload: {
        cwd: "/Users/huntharo/github/PwrAgnt",
      },
      type: "turn_context",
    });
  });

  it("reports a missing session without throwing", async () => {
    const codexHome = await makeTempDir();

    await expect(
      new CodexSessionMetadataService({ codexHome }).updateThreadCwd({
        cwd: "/repo/app/.worktrees/thread-1/app",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      reason: "missing-session",
      updated: false,
    });
  });
});
