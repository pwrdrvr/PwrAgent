import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isCodexInvalidResponseMessageIdError,
  repairCodexInvalidResponseMessageIds,
} from "../codex-app-server/invalid-response-message-id-recovery";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/codex-invalid-id-recovery",
);
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map(async (directory) =>
      await rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("invalid persisted Codex response-message ID recovery", () => {
  it("repairs review IDs recursively while preserving valid non-message IDs", async () => {
    const threadId = "019fb6c7-1545-77c1-be52-98f86cae3c11";
    const fixture = await readFile(
      path.join(fixtureRoot, "legacy-review-compacted.jsonl"),
    );
    const target = await createRolloutTarget({ fixture, threadId });
    await chmod(target.rolloutPath, 0o640);
    const expectedRolloutPath = await realpath(target.rolloutPath);

    const result = await repairCodexInvalidResponseMessageIds({
      codexHome: target.codexHome,
      now: () => Date.parse("2026-08-01T12:34:56.789Z"),
      rolloutPath: target.rolloutPath,
      threadId,
      uniqueSuffix: () => "test-backup",
    });

    expect(result).toEqual({
      backupPath:
        `${expectedRolloutPath}.pwragent-invalid-message-id-`
        + "2026-08-01T12-34-56-789Z-test-backup.bak",
      removedMessageIdCount: 2,
      rolloutPath: expectedRolloutPath,
      threadId,
    });
    expect(await readFile(result.backupPath)).toEqual(fixture);
    expect((await stat(target.rolloutPath)).mode & 0o7777).toBe(0o640);

    const records = await readJsonl(target.rolloutPath);
    expect(records).toHaveLength(3);
    const replacementHistory = records[1]!.payload.replacement_history as Array<
      Record<string, unknown>
    >;
    expect(replacementHistory[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "review request" }],
      internal_chat_message_metadata_passthrough: { source: "review" },
    });
    expect(replacementHistory[1]!.id).toBe("msg_valid_assistant");
    expect(replacementHistory[2]!.id).toBe("cmp_valid_compaction");
    expect(records[2]!.payload).not.toHaveProperty("id");
    expect(records[2]!.payload.content).toEqual([
      { type: "output_text", text: "review result" },
    ]);
  });

  it("removes a bare UUID only when it is a response message ID", async () => {
    const threadId = "019fb19b-637e-72f0-b567-56f624e2ee2c";
    const fixture = await readFile(
      path.join(fixtureRoot, "bare-uuid-message-id.jsonl"),
    );
    const target = await createRolloutTarget({ fixture, threadId });

    const result = await repairCodexInvalidResponseMessageIds({
      codexHome: target.codexHome,
      rolloutPath: target.rolloutPath,
      threadId,
      uniqueSuffix: () => "uuid-backup",
    });

    expect(result.removedMessageIdCount).toBe(1);
    const records = await readJsonl(target.rolloutPath);
    expect(records[0]!.payload.id).toBe(threadId);
    expect(records[0]!.payload.session_id).toBe(threadId);
    expect(records[1]!.payload).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hook-injected message" }],
      internal_chat_message_metadata_passthrough: { source: "hook" },
    });
  });

  it("rejects a protocol path that points at a different thread", async () => {
    const fixtureThreadId = "019fb19b-637e-72f0-b567-56f624e2ee2c";
    const requestedThreadId = "019fb19b-637e-72f0-b567-56f624e2ee2d";
    const fixture = await readFile(
      path.join(fixtureRoot, "bare-uuid-message-id.jsonl"),
    );
    const target = await createRolloutTarget({
      fixture,
      threadId: requestedThreadId,
    });

    await expect(
      repairCodexInvalidResponseMessageIds({
        codexHome: target.codexHome,
        rolloutPath: target.rolloutPath,
        threadId: requestedThreadId,
      }),
    ).rejects.toThrow(
      `Codex recovery target belongs to thread ${fixtureThreadId}, not ${requestedThreadId}`,
    );
  });

  it("rejects a rollout path outside the configured Codex session roots", async () => {
    const threadId = "019fb19b-637e-72f0-b567-56f624e2ee2c";
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-id-path-"));
    tempDirectories.push(root);
    const codexHome = path.join(root, "codex-home");
    const outsideDirectory = path.join(root, "outside");
    await mkdir(path.join(codexHome, "sessions"), { recursive: true });
    await mkdir(outsideDirectory, { recursive: true });
    const rolloutPath = path.join(
      outsideDirectory,
      `rollout-2026-07-31T00-00-00-${threadId}.jsonl`,
    );
    await writeFile(
      rolloutPath,
      await readFile(path.join(fixtureRoot, "bare-uuid-message-id.jsonl")),
    );

    await expect(
      repairCodexInvalidResponseMessageIds({
        codexHome,
        rolloutPath,
        threadId,
      }),
    ).rejects.toThrow("outside the configured session storage");
  });

  it("matches only the Responses API invalid message-ID-prefix failure", () => {
    expect(
      isCodexInvalidResponseMessageIdError(
        new Error(
          "[ApiIdParam] [input[169].id] [invalid_id_prefix] "
          + "Invalid 'input[169].id': 'review_rollout_user'. "
          + "Expected an ID that begins with 'msg'.",
        ),
      ),
    ).toBe(true);
    expect(
      isCodexInvalidResponseMessageIdError(
        new Error("[invalid_id_prefix] Invalid 'item.id': 'review_rollout_user'."),
      ),
    ).toBe(false);
    expect(
      isCodexInvalidResponseMessageIdError(
        new Error("stream disconnected before completion"),
      ),
    ).toBe(false);
  });
});

async function createRolloutTarget(params: {
  fixture: Buffer;
  threadId: string;
}): Promise<{ codexHome: string; rolloutPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-id-recovery-"));
  tempDirectories.push(root);
  const codexHome = path.join(root, "codex-home");
  const sessionDirectory = path.join(codexHome, "sessions/2026/07/31");
  await mkdir(sessionDirectory, { recursive: true });
  const rolloutPath = path.join(
    sessionDirectory,
    `rollout-2026-07-31T00-00-00-${params.threadId}.jsonl`,
  );
  await writeFile(rolloutPath, params.fixture);
  return { codexHome, rolloutPath };
}

async function readJsonl(
  filePath: string,
): Promise<Array<{ payload: Record<string, unknown>; type: string }>> {
  return (await readFile(filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}
