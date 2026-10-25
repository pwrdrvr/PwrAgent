import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadReplay, ThreadUsageLineRecord } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";
import * as appState from "../state/app-state";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

// A messaging binding resolves the final reply's images when a turn ends,
// twice per turn (the final agentMessage and turn/completed), before the reply
// is posted. It needs transcript entries only. On a thread with thousands of
// usage lines and Token Miser gates, a full read also re-read the pricing
// ledger and rebuilt Token Miser accounting on the main process, which blocked
// the app and delayed the chat reply at every turn end.

const THREAD_ID = "thread-bound";

let db: StateDb;
let tempDir: string;
let objectsDir: string;

beforeEach(() => {
  const fixture = createTempStateDb("messaging-image-read-");
  tempDir = fixture.tempDir;
  db = StateDb.open(fixture.dbPath);
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
  objectsDir = mkdtempSync(path.join(os.tmpdir(), "messaging-image-read-miser-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  removeTempStateDbDir(tempDir);
  rmSync(objectsDir, { force: true, recursive: true });
});

function createRegistry() {
  const readThread = vi.fn(async () => finalTurnReplay());
  const client = {
    close: async () => {},
    getInitializeResult: async () => ({ methods: ["thread/read"] }),
    listNativeSubAgentThreads: async () => [],
    listThreads: async () => [],
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
    readThread,
  };
  const store = new SqliteOverlayStore(db);
  const registry = new DesktopBackendRegistry({
    codexClient: client as never,
    overlayStore: store,
    messagingStore: null,
  });
  const tokenMiserStore = new TestTokenMiserStore(objectsDir);
  (registry as unknown as { tokenMiserStore: TestTokenMiserStore }).tokenMiserStore = tokenMiserStore;
  return {
    readPricing: vi.spyOn(store, "readThreadPricing"),
    readToolAccounting: vi.spyOn(store, "readThreadToolAccounting"),
    listGates: vi.spyOn(tokenMiserStore, "listMetadata"),
    readThread,
    registry,
  };
}

describe("messaging final-reply image lookup", () => {
  it("reads the transcript without the pricing ledger, Token Miser accounting, or usage writes", async () => {
    const { listGates, readPricing, readToolAccounting, registry } = createRegistry();
    const bridge = new DesktopMessagingBackendBridge(registry);
    try {
      await expect(bridge.resolveAssistantMessageImages({
        backend: "codex",
        itemId: "assistant-final",
        text: "Final screenshot.",
        threadId: THREAD_ID,
        turnId: "turn-final",
      })).resolves.toEqual([{
        type: "image",
        url: "https://example.com/final.png",
        alt: "Final screenshot",
        source: "assistant",
      }]);

      expect(readPricing).not.toHaveBeenCalled();
      expect(readToolAccounting).not.toHaveBeenCalled();
      expect(listGates).not.toHaveBeenCalled();
      // A lookup is not a thread selection: it must not hydrate usage rows.
      expect(db.raw.prepare("SELECT COUNT(*) AS count FROM thread_usage_lines").get())
        .toEqual({ count: 0 });
    } finally {
      await registry.close();
    }
  });
});

describe("transcript-only thread reads", () => {
  it("skip accounting only when the caller opts out", async () => {
    const { listGates, readPricing, readToolAccounting, registry } = createRegistry();
    try {
      const transcriptOnly = await registry.readThread({
        backend: "codex",
        includeAccounting: false,
        threadId: THREAD_ID,
        viewOnly: true,
      });
      expect(transcriptOnly.replay.messages.map((message) => message.id))
        .toEqual(["user-final", "assistant-final"]);
      expect(transcriptOnly.pricing).toBeUndefined();
      expect(transcriptOnly.toolAccounting).toBeUndefined();
      expect(readPricing).not.toHaveBeenCalled();
      expect(readToolAccounting).not.toHaveBeenCalled();
      expect(listGates).not.toHaveBeenCalled();

      // The default read is unchanged: the thread view's pricing summary and
      // Token Miser savings still come from it.
      const full = await registry.readThread({ backend: "codex", threadId: THREAD_ID, viewOnly: true });
      expect(full.pricing).toBeDefined();
      expect(full.toolAccounting).toBeDefined();
      expect(readPricing).toHaveBeenCalled();
      expect(listGates).toHaveBeenCalledWith(THREAD_ID);
    } finally {
      await registry.close();
    }
  });
});

function finalTurnReplay(): AppServerThreadReplay {
  const usageLine: ThreadUsageLineRecord = {
    backend: "codex", threadId: THREAD_ID, turnId: "turn-final", usageLineId: "usage-final",
    provider: "openai", model: "gpt-5.5", scope: "turn", source: "hydration", sourceItemId: "turn-final",
    status: "finalized", priceStatus: "unpriced", currency: "USD", createdAt: 2000, completedAt: 2000,
    inputTokens: 1500, cachedInputTokens: 1200, uncachedInputTokens: 300, outputTokens: 150,
    reasoningOutputTokens: 0, totalTokens: 1650, uncachedInputCostMicros: 0, cachedInputCostMicros: 0,
    outputCostMicros: 0, totalCostMicros: 0,
  };
  return {
    entries: [{
      type: "activity", id: "turn-final-usage", summary: "Turn usage", status: "completed", details: [],
      turn: { id: "turn-final", status: "completed" }, usageLine,
    }],
    messages: [
      { id: "user-final", role: "user", text: "Show me the result." },
      {
        id: "assistant-final",
        role: "assistant",
        text: "Final screenshot.",
        parts: [
          { type: "text", text: "Final screenshot." },
          { type: "image", url: "https://example.com/final.png", alt: "Final screenshot" },
        ],
      },
    ],
    pagination: { supportsPagination: false, hasPreviousPage: false },
  };
}
