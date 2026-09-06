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
  it("bounds metadata reads across overlapping scans and store instances", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
    temporaryDirectories.push(root);
    const first = new TokenMiserStore(root);
    const second = new TokenMiserStore(root);
    for (let index = 0; index < 40; index += 1) {
      await createObject(first, `output-${index}`, index);
      await first.recordCodeModeObservation({
        threadId: "thread-owner",
        turnId: "turn-1",
        callId: `call-${index}`,
        cellId: `cell-${index}`,
        outputCharacters: 100,
        maxOutputTokens: 1_000,
        scriptStatus: "completed",
        retrieval: false,
        capturedNestedInvocationCount: 1,
      });
    }

    let releaseReads!: () => void;
    const gate = new Promise<void>((resolve) => { releaseReads = resolve; });
    let active = 0;
    let peak = 0;
    const readFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (file, options) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await gate;
        return await readFile(file, options);
      } finally {
        active -= 1;
      }
    });
    const scans = Promise.all([
      first.listMetadata(),
      second.listMetadata(),
      first.listCodeModeObservations("thread-owner"),
      second.listCodeModeObservations("thread-owner"),
    ]);
    try {
      await vi.waitFor(() => expect(active).toBe(16));
      releaseReads();
      const results = await scans;
      expect(results.map((entries) => entries.length)).toEqual([40, 40, 40, 40]);
      expect(readSpy).toHaveBeenCalledTimes(160);
      expect(peak).toBeLessThanOrEqual(16);
      expect(active).toBe(0);
    } finally {
      releaseReads();
      await scans;
      readSpy.mockRestore();
    }
  });

  it("releases metadata read slots after filesystem failures", async () => {
    const store = await createStore();
    const entry = await createObject(store, "retained output", 1);
    const readFile = fs.readFile.bind(fs);
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(
      Object.assign(new Error("read failed"), { code: "EIO" }),
    );
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => store.readMetadata(entry.objectId)),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      readSpy.mockImplementation(readFile);
      expect(await store.readMetadata(entry.objectId)).toEqual(entry);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("counts all decisions separately from helper evaluations", async () => {
    const store = await createStore();
    const helperUsage = (ordinal: number) => ({
      helperThreadId: `helper-${ordinal}`,
      helperTurnId: `helper-turn-${ordinal}`,
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
      tokenUsage: {
        inputTokens: 2_000,
        outputTokens: 100,
        totalTokens: 2_100,
      },
    });
    await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-summary",
      toolName: "Code Mode",
      output: "summarized output",
      replacementCharacters: 100,
      summary: { summary: "Summary.", usefulDetails: [] },
      disposition: "summarized",
      helperUsage: helperUsage(1),
    });
    await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-helper-pass",
      toolName: "Code Mode",
      output: "helper pass-through output",
      replacementCharacters: 26,
      summary: { summary: "Passed through by helper.", usefulDetails: [] },
      disposition: "passed_through",
      helperUsage: helperUsage(2),
    });
    await store.store({
      threadId: "thread-owner",
      turnId: "turn-1",
      toolUseId: "tool-policy-pass",
      toolName: "Code Mode",
      output: "policy pass-through output",
      replacementCharacters: 26,
      summary: { summary: "Passed through by policy.", usefulDetails: [] },
      disposition: "passed_through",
    });

    const usage = await store.summarizeThreadUsage("thread-owner");
    expect(usage).toMatchObject({
      interceptionCount: 3,
      helperDecisionCount: 2,
      passThroughCount: 2,
      helperPassThroughCount: 1,
      policyPassThroughCount: 1,
    });
    expect(usage.interceptions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolUseId: "tool-summary",
        disposition: "summarized",
        decisionSource: "helper",
      }),
      expect.objectContaining({
        toolUseId: "tool-helper-pass",
        disposition: "passed_through",
        decisionSource: "helper",
      }),
      expect.objectContaining({
        toolUseId: "tool-policy-pass",
        disposition: "passed_through",
        decisionSource: "policy",
      }),
    ]));
  });

  it("distinguishes unavailable and legacy capture from captured zero command counts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
    temporaryDirectories.push(root);
    const store = new TokenMiserStore(root);
    const observation = {
      threadId: "thread-owner", turnId: "turn-1", cellId: "cell-1",
      outputCharacters: 100, maxOutputTokens: 10_000, scriptStatus: "completed", retrieval: false,
    };
    await store.recordCodeModeObservation({
      ...observation, callId: "unavailable", capturedNestedInvocationCount: null,
    });
    await store.recordCodeModeObservation({
      ...observation, callId: "legacy", capturedNestedInvocationCount: 0,
      capturedCommandInvocationCount: 0, capturedOtherInvocationCount: 0,
    });
    expect((await store.summarizeThreadUsage("thread-owner")).codeMode).toMatchObject({
      callCount: 2, unclassifiedCellCount: 2, commandCellCount: null,
      capturedNestedInvocationCount: null, otherCellCount: null, pollingCellCount: null,
    });
    await store.recordCodeModeObservation({
      ...observation, callId: "patch", capturedNestedInvocationCount: 1,
      capturedCommandInvocationCount: 0, capturedPatchInvocationCount: 1,
    });
    expect((await store.summarizeThreadUsage("thread-owner")).codeMode).toMatchObject({
      callCount: 3, unclassifiedCellCount: 2, commandCellCount: 0,
      capturedNestedInvocationCount: 1, patchCellCount: 1, otherCellCount: 0,
    });
  });

  it("counts every Code Mode reducer request separately from gate decisions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
    temporaryDirectories.push(root);
    const onCodeModeObservationUpdated = vi.fn();
    const store = new TokenMiserStore(root, { onCodeModeObservationUpdated });
    await store.recordCodeModeObservation({
      threadId: "thread-owner",
      turnId: "turn-1",
      callId: "call-direct",
      cellId: "cell-direct",
      outputCharacters: 4_900,
      maxOutputTokens: 10_000,
      scriptStatus: "completed",
      script: "text(await exec())",
      retrieval: false,
      capturedNestedInvocationCount: 1,
    });
    await store.recordCodeModeObservation({
      threadId: "thread-owner",
      turnId: "turn-1",
      callId: "call-retrieval",
      cellId: "cell-retrieval",
      outputCharacters: 2_000,
      maxOutputTokens: 10_000,
      scriptStatus: "completed",
      retrieval: true,
      capturedNestedInvocationCount: 1,
    });

    expect(await store.summarizeThreadUsage("thread-owner")).toMatchObject({
      interceptionCount: 0,
      codeMode: {
        callCount: 2,
        commandCellCount: 1,
        directCommandCellCount: 1,
        dispatchClusterCount: 1,
        multiInvocationClusterCount: 0,
        largestDispatchCluster: 1,
        nestedCommandInvocationCount: 1,
        patchCellCount: 0,
        otherCellCount: 0,
        pollingCellCount: 0,
        directCount: 1,
        summarizedCount: 0,
        passThroughCount: 0,
        retrievalCount: 1,
        capturedNestedInvocationCount: 2,
      },
    });
    expect(onCodeModeObservationUpdated).toHaveBeenCalledTimes(2);
    expect((await store.listCodeModeObservations("thread-owner")))
      .toHaveLength(2);
    await store.prune({
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxBytes: 0,
    });
    expect(await store.listCodeModeObservations("thread-owner")).toHaveLength(2);
  });

  it("reports new and retrieved metadata for turn-batched accounting", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pwragent-token-miser-"));
    temporaryDirectories.push(root);
    const onMetadataUpdated = vi.fn();
    const store = new TokenMiserStore(root, { onMetadataUpdated });
    const metadata = await createObject(store, "alpha\nbeta", 1);

    // The reason lets the registry skip a full ledger republish for writes that
    // only advance replay counters.
    expect(onMetadataUpdated).toHaveBeenLastCalledWith(metadata, "stored");
    const result = await store.readAll({
      objectId: metadata.objectId,
      threadId: "thread-owner",
    });
    const delivery = await store.prepareRetrievalDelivery({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      visibleText: result!.text,
    });

    expect(onMetadataUpdated).toHaveBeenCalledTimes(1);
    await store.confirmModelVisibleRetrievals({
      output: delivery!.text,
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
    await expect(fs.stat(root)).rejects.toMatchObject({ code: "ENOENT" });
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
    expect(await fs.readdir(root).catch(() => [])).toEqual([]);
    expect(await store.listMetadata()).toEqual([]);

    const accepted = await store.stage(params);
    await Promise.all([
      accepted.commit(),
      accepted.commit(),
      accepted.persist(),
    ]);
    expect(await fs.readdir(root)).toEqual(["threads"]);
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
    const searchDelivery = await store.prepareRetrievalDelivery({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      visibleText: JSON.stringify(search),
    });
    await store.confirmModelVisibleRetrievals({
      output: searchDelivery!.text,
      threadId: "thread-owner",
    });
    const readDelivery = await store.prepareRetrievalDelivery({
      objectId: metadata.objectId,
      threadId: "thread-owner",
      visibleText: read!.text,
    });
    await store.confirmModelVisibleRetrievals({
      output: readDelivery!.text,
      threadId: "thread-owner",
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

  it("preserves accounting independently of the former raw-output quota", async () => {
    const store = await createStore();
    const expired = await createObject(store, "expired", 1);
    const older = await createObject(store, "older", 100);
    const newer = await createObject(store, "newer", 200);

    await store.prune({ maxAgeMs: 250, maxBytes: 6, now: 300 });

    expect(await store.readMetadata(expired.objectId)).toBeDefined();
    expect(await store.readMetadata(older.objectId)).toBeDefined();
    expect(await store.readMetadata(newer.objectId)).toBeDefined();
  });

  it("never writes staged originals into the legacy flat directory", async () => {
    const store = await createStore();
    const staged = await store.stage({ threadId: "owner", turnId: "turn", toolUseId: "tool", toolName: "Bash", output: "private", replacementCharacters: 10, summary: { summary: "private", usefulDetails: [] } });
    await staged.persist();
    await store.prune({ maxAgeMs: 0, maxBytes: 0 });
    expect(await store.listMetadata()).toEqual([]);
    await staged.discard();
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
