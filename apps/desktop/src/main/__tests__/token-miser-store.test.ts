import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenMiserStore } from "../token-miser/token-miser-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("TokenMiserStore", () => {
  it("reports new and retrieved metadata for turn-batched accounting", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
    temporaryDirectories.push(root);
    const onMetadataUpdated = vi.fn();
    const store = new TokenMiserStore(root, { onMetadataUpdated });
    const metadata = await createObject(store, "alpha\nbeta", 1);

    // The reason lets the registry skip a full ledger republish for writes that
    // only advance replay counters.
    expect(onMetadataUpdated).toHaveBeenLastCalledWith(metadata, "stored");
    await store.readAll({
      objectId: metadata.objectId,
      threadId: "thread-owner",
    });

    expect(onMetadataUpdated).toHaveBeenCalledTimes(2);
    expect(onMetadataUpdated.mock.calls[1]?.[1]).toBe("retrieval");
    expect(onMetadataUpdated.mock.calls[1]?.[0].retrievedCharacters)
      .toBeGreaterThan(0);
  });

  it("publishes staged output only after commit and removes rejected output", async () => {
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-"),
    );
    temporaryDirectories.push(parent);
    const root = path.join(parent, "objects");
    const onMetadataUpdated = vi.fn();
    const store = new TokenMiserStore(root, { onMetadataUpdated });
    const params = {
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Code Mode",
      output: "large output",
      replacementCharacters: 100,
      summary: {
        summary: "Large output.",
        usefulDetails: [],
        suggestedNextStep: "Read it if needed.",
      },
    };
    const rejected = await store.stage(params);

    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
    await rejected.persist();
    expect((await fs.readdir(root)).sort()).toEqual([
      `${rejected.metadata.objectId}.txt`,
    ]);
    expect(await store.listMetadata()).toEqual([]);
    expect(await store.readMetadata(rejected.metadata.objectId))
      .toBeUndefined();
    expect(await store.readAll({
      objectId: rejected.metadata.objectId,
      threadId: params.threadId,
    })).toBeUndefined();
    expect(await store.readLines({
      objectId: rejected.metadata.objectId,
      threadId: params.threadId,
    })).toBeUndefined();
    expect(await store.search({
      objectId: rejected.metadata.objectId,
      threadId: params.threadId,
      query: "large",
    })).toBeUndefined();
    expect(await store.summarizeUsage()).toMatchObject({
      interceptionCount: 0,
      estimatedParentTokensSaved: 0,
    });
    expect(await store.summarizeThreadUsage(params.threadId)).toMatchObject({
      interceptionCount: 0,
      interceptions: [],
    });
    const reopenedStore = new TokenMiserStore(root);
    expect(await reopenedStore.listMetadata()).toEqual([]);
    expect(await reopenedStore.readAll({
      objectId: rejected.metadata.objectId,
      threadId: params.threadId,
    })).toBeUndefined();
    expect(onMetadataUpdated).not.toHaveBeenCalled();
    await Promise.all([
      rejected.discard(),
      rejected.discard(),
      rejected.persist(),
    ]);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await store.listMetadata()).toEqual([]);

    const accepted = await store.stage(params);
    await Promise.all([
      accepted.commit(),
      accepted.commit(),
      accepted.persist(),
    ]);
    expect((await fs.readdir(root)).sort()).toEqual([
      `${accepted.metadata.objectId}.json`,
      `${accepted.metadata.objectId}.txt`,
    ]);
    expect(await store.listMetadata()).toEqual([accepted.metadata]);
    expect(onMetadataUpdated).toHaveBeenCalledOnce();
    expect(onMetadataUpdated).toHaveBeenCalledWith(
      accepted.metadata,
      "stored",
    );
  });

  it("stores output, restricts reads to the owning thread, and accounts retrieval", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "alpha\nneedle one\nomega\nneedle two",
      replacementCharacters: 300,
      summary: {
        summary: "Two matching lines.",
        usefulDetails: ["needle one", "needle two"],
        suggestedNextStep: "Read the matching lines.",
      },
    });

    expect(
      await store.readLines({
        objectId: metadata.objectId,
        threadId: "thread-other",
      }),
    ).toBeUndefined();

    const search = await store.search({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      query: "needle",
    });
    expect(search?.matches).toEqual([
      { line: 2, text: "needle one" },
      { line: 4, text: "needle two" },
    ]);

    const read = await store.readLines({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      startLine: 2,
      endLine: 3,
    });
    expect(read).toMatchObject({
      startLine: 2,
      endLine: 3,
      totalLines: 4,
      text: "needle one\nomega",
    });
    expect(
      (await store.readMetadata(metadata.objectId))?.retrievedCharacters,
    ).toBeGreaterThan("needle one".length + "needle two".length);
    expect((await store.summarizeUsage()).retrievedTokens).toBeGreaterThan(0);
    expect((await store.summarizeUsage({ threadId: "thread-owner" })))
      .toMatchObject({ interceptionCount: 1 });
    expect((await store.summarizeUsage({ threadId: "thread-other" })))
      .toMatchObject({
        interceptionCount: 0,
        estimatedParentTokensSaved: 0,
      });
    expect(await store.summarizeThreadUsage("thread-owner")).toMatchObject({
      interceptionCount: 1,
      interceptions: [{
        objectId: metadata.objectId,
        toolUseId: "tool-1",
        turnId: "turn-1",
        baselineParentTokens: metadata.baselineParentTokens,
      }],
    });
  });

  it("honors a provider-supplied model-visible token ceiling", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "code-mode-call-1",
      toolName: "Code mode",
      output: "x".repeat(24_000),
      baselineParentTokenCap: 2_000,
      replacementCharacters: 400,
      summary: {
        summary: "Large code-mode output.",
        usefulDetails: [],
        suggestedNextStep: "Read a targeted range.",
      },
    });

    expect(metadata.baselineParentTokens).toBe(2_000);
  });

  // The registry owns the request boundary now, holding one cursor per thread
  // so every gate is offered the same events. This per-gate mark stays as a
  // backstop, and the two can never disagree: the thread cursor is seeded from
  // the highest gate mark and only moves above it, so anything the registry
  // accepts already clears every gate's own mark.
  it("ignores a request that does not advance the gate's own mark", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "x".repeat(24_000),
      replacementCharacters: 400,
      parentCumulativeInputTokens: 5_000,
      summary: {
        summary: "Large output.",
        usefulDetails: [],
        suggestedNextStep: "None.",
      },
    });

    expect(await store.recordParentModelRequest({
      cumulativeInputTokens: 4_000,
      objectId: metadata.objectId,
    })).toBeUndefined();
    expect(await store.recordParentModelRequest({
      cumulativeInputTokens: 5_000,
      objectId: metadata.objectId,
    })).toBeUndefined();
    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      parentRequestsObservedAfterGate: 0,
      lastParentCumulativeInputTokens: 5_000,
    });

    expect(await store.recordParentModelRequest({
      cumulativeInputTokens: 6_000,
      objectId: metadata.objectId,
    })).toBeDefined();
    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      parentRequestsObservedAfterGate: 1,
    });
  });

  it("re-anchors a persisted request watermark for a new app-server epoch", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "x".repeat(24_000),
      replacementCharacters: 400,
      summary: {
        summary: "Large output.",
        usefulDetails: [],
        suggestedNextStep: "None.",
      },
    });

    await store.recordParentModelRequest({
      cumulativeInputTokens: 20_000,
      objectId: metadata.objectId,
      requestEpoch: "process-a",
    });
    await expect(store.recordParentModelRequest({
      cumulativeInputTokens: 500,
      objectId: metadata.objectId,
      requestEpoch: "process-b",
    })).resolves.toBeDefined();

    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      lastParentCumulativeInputTokens: 500,
      parentRequestEpoch: "process-b",
      parentRequestsObservedAfterGate: 2,
    });
  });

  it("tracks cached parent replays after the first request until compaction", async () => {
    const store = await createStore();
    const metadata = await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-1",
      toolName: "Bash",
      output: "x".repeat(24_000),
      replacementCharacters: 400,
      parentCumulativeInputTokens: 1_000,
      summary: {
        summary: "Large output.",
        usefulDetails: [],
        suggestedNextStep: "None.",
      },
    });

    await store.recordParentModelRequest({
      cumulativeInputTokens: 2_000,
      objectId: metadata.objectId,
    });
    await store.recordParentModelRequest({
      cumulativeInputTokens: 2_000,
      objectId: metadata.objectId,
    });
    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      parentRequestsObservedAfterGate: 1,
      cachedReplayCount: 0,
    });

    await store.recordParentModelRequest({
      cumulativeInputTokens: 3_000,
      objectId: metadata.objectId,
    });
    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      parentRequestsObservedAfterGate: 2,
      cachedReplayCount: 0,
    });
    await store.recordParentModelRequest({
      cumulativeInputTokens: 4_000,
      objectId: metadata.objectId,
    });
    await store.recordParentModelRequest({
      cumulativeInputTokens: 5_000,
      objectId: metadata.objectId,
    });
    await store.stopReplayTracking({
      objectId: metadata.objectId,
      stoppedAt: 6_000,
    });
    await store.recordParentModelRequest({
      cumulativeInputTokens: 6_000,
      objectId: metadata.objectId,
    });

    expect(await store.readMetadata(metadata.objectId)).toMatchObject({
      cachedReplayCount: 2,
      cachedBaselineTokens: 12_000,
      cachedRevealedTokens: 200,
      replayTrackingStoppedAt: 6_000,
    });
    expect(await store.summarizeThreadUsage("thread-owner")).toMatchObject({
      cachedReplayCount: 2,
      cachedBaselineTokens: 12_000,
      cachedRevealedTokens: 200,
      estimatedCachedReplayTokensSaved: 11_800,
    });
  });

  it("prunes expired and over-budget outputs oldest first", async () => {
    const store = await createStore();
    const expired = await createObject(store, "expired", 1);
    const older = await createObject(store, "older", 100);
    const newer = await createObject(store, "newer", 200);

    await store.prune({ maxAgeMs: 250, maxBytes: 6, now: 300 });

    expect(await store.readMetadata(expired.objectId)).toBeUndefined();
    expect(await store.readMetadata(older.objectId)).toBeUndefined();
    expect(await store.readMetadata(newer.objectId)).toBeDefined();
  });
});

async function createStore(): Promise<TokenMiserStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
  temporaryDirectories.push(root);
  return new TokenMiserStore(root);
}

async function createObject(
  store: TokenMiserStore,
  output: string,
  now: number,
) {
  return await store.store({
    threadId: "thread-owner",
    turnId: `turn-${now}`,
    toolUseId: `tool-${now}`,
    toolName: "Bash",
    output,
    replacementCharacters: 100,
    summary: {
      summary: output,
      usefulDetails: [],
      suggestedNextStep: "None.",
    },
    now,
  });
}
