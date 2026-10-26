import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingImagePart,
  MessagingSurfaceIntent,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type {
  AgentEvent,
  AppServerThreadReplay,
  FederationCapability,
  FederationProtocolEnvelope,
  FederationRemoteTarget,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import {
  resetDesktopOverlayStoreForTests,
  setDesktopOverlayStoreForTests,
} from "../app-server/desktop-overlay-store";
import { extractThreadReplayFromReadResult } from "../codex-app-server/client";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import {
  readThreadForPeer,
  readTurnAssistantReplyForPeer,
} from "../federation/federation-owner-thread-reads";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { MessagingController } from "../messaging/core/messaging-controller";
import { MessagingStore } from "../messaging/core/messaging-store";
import {
  DesktopMessagingBackendBridge,
  type DesktopMessagingFederationBridge,
} from "../messaging/desktop-backend-bridge";
import {
  readTranscriptImageProtocolRequest,
  rewriteFederatedTranscriptImageUrlsForRenderer,
} from "../transcript-image-protocol";
import * as appState from "../state/app-state";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { TestTokenMiserStore } from "./token-miser-test-store";

// A messaging binding resolves the final reply's images when a turn ends,
// before the reply is posted. The reply's images come from the turn that just
// finished: its final assistant message, Markdown image links in that text,
// and screenshots its tool calls returned. Reading a 20-turn transcript page to
// find that one message re-parsed the page, the thread overlay, and the pricing
// ledger on the main process at every turn end, and did it twice: once for the
// final agentMessage and again for turn/completed. On a thread with thousands
// of turns that blocked the app and delayed the chat reply.
//
// These tests drive the real messaging controller, bridge, and registry over a
// fake Codex client. The fake normalizes raw Codex turns with the production
// replay normalizer, so the parts it returns are the parts a real read returns.

const THREAD_ID = "thread-bound";
const FINAL_TURN_ID = "turn-final";
// A 1x1 PNG. The materializer validates image bytes, so this must be real.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

type RawItem = Record<string, unknown>;
type RawTurn = { id: string; items: RawItem[] };

let db: StateDb;
let tempDir: string;
let workDir: string;

beforeEach(() => {
  vi.stubEnv("PWRAGENT_DEV_SQLITE_WRITE_METRICS", "1");
  const fixture = createTempStateDb("messaging-image-read-");
  tempDir = fixture.tempDir;
  db = StateDb.open(fixture.dbPath);
  vi.spyOn(appState, "getAppStateDb").mockReturnValue(db);
  workDir = mkdtempSync(path.join(os.tmpdir(), "messaging-image-read-work-"));
});

afterEach(() => {
  resetDesktopOverlayStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  db.close();
  removeTempStateDbDir(tempDir);
  rmSync(workDir, { force: true, recursive: true });
});

/** Methods of the Codex client that read thread history over the protocol. */
const PROTOCOL_READS = new Set([
  "readThread",
  "readThreadActivity",
  "readThreadSummary",
  "readThreadTurn",
]);

function createFakeCodexClient(turns: RawTurn[]) {
  const protocolReads: string[] = [];
  let turnsNormalized = 0;
  const normalize = (
    selected: RawTurn[],
    page: { hasPreviousPage: boolean } | undefined = undefined,
  ): AppServerThreadReplay => {
    turnsNormalized += selected.length;
    return extractThreadReplayFromReadResult(
      {
        thread: { id: THREAD_ID, turns: selected },
        // A bounded read is a thread/turns/list page, which the real client
        // reports as paginated. A federation owner re-reads the whole thread
        // for a backend that cannot page.
        ...(page
          ? {
            supportsPagination: true,
            hasPreviousPage: page.hasPreviousPage,
            ...(page.hasPreviousPage ? { previousCursor: "older-turns" } : {}),
          }
          : {}),
      },
      { threadId: THREAD_ID },
    );
  };
  const client = {
    close: async () => {},
    getInitializeResult: async () => ({ methods: ["thread/read"] }),
    listNativeSubAgentThreads: async () => [],
    listThreads: async () => [],
    onNotification: () => () => {},
    onPendingRequest: () => () => {},
    // Honors `limit` the way thread/turns/list pages do: newest turns first.
    readThread: async (params: { limit?: number }) => params.limit === undefined
      ? normalize(turns)
      : normalize(
        turns.slice(Math.max(0, turns.length - params.limit)),
        { hasPreviousPage: turns.length > params.limit },
      ),
    readThreadTurn: async (params: { turnId: string }) => normalize(
      turns.filter((turn) => turn.id === params.turnId),
    ),
  };
  const counted = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function" || !PROTOCOL_READS.has(property)) {
        return value;
      }
      return (...args: unknown[]) => {
        protocolReads.push(property);
        return (value as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    client: counted,
    protocolReads,
    turnsNormalized: () => turnsNormalized,
  };
}

async function createBoundThread(turns: RawTurn[], options: { linkedDirectory?: string } = {}) {
  const codex = createFakeCodexClient(turns);
  const store = new SqliteOverlayStore(db);
  // The bridge's admission check reads the app's overlay store; make it this
  // one so its parses count in the budget too.
  setDesktopOverlayStoreForTests(store);
  if (options.linkedDirectory) {
    await store.addLinkedDirectory({
      backend: "codex",
      directory: {
        id: "linked-project",
        kind: "local",
        label: "project",
        path: options.linkedDirectory,
      },
      threadId: THREAD_ID,
    });
  }
  const registry = new DesktopBackendRegistry({
    codexClient: codex.client as never,
    overlayStore: store,
    messagingStore: null,
  });
  const tokenMiserStore = new TestTokenMiserStore(path.join(workDir, "token-miser"));
  (registry as unknown as { tokenMiserStore: TestTokenMiserStore }).tokenMiserStore = tokenMiserStore;
  const bridge = new DesktopMessagingBackendBridge(registry);
  const messagingStore = new MessagingStore(path.join(workDir, "messaging-state.json"));
  await messagingStore.upsertBinding({
    id: "binding-1",
    authorizedActorIds: ["user-1"],
    backend: "codex",
    channel: { channel: "telegram", conversation: { id: "chat-1", kind: "dm" } },
    createdAt: 1_000,
    targetKind: "thread",
    threadId: THREAD_ID,
    updatedAt: 1_000,
  });
  const delivered: MessagingSurfaceIntent[] = [];
  const controller = new MessagingController({
    adapter: {
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      deliver: async (intent) => {
        delivered.push(intent);
        return {
          channel: "telegram",
          deliveredAt: 1_000,
          outcome: "presented",
          surface: { channel: "telegram", id: `surface:${intent.id}` },
        };
      },
    },
    authorizedActorIds: ["user-1"],
    backend: bridge,
    inputDebounceMs: 0,
    now: () => 1_000,
    store: messagingStore,
  });
  return {
    bridge,
    codex,
    controller,
    delivered,
    imageRoots: vi.spyOn(registry, "getThreadTranscriptImageRoots"),
    overlayParses: vi.spyOn(store, "getThreadOverlayState"),
    pricingReads: vi.spyOn(store, "readThreadPricing"),
    registry,
    toolAccountingReads: vi.spyOn(store, "readThreadToolAccounting"),
    tokenMiserGateReads: vi.spyOn(tokenMiserStore, "listMetadata"),
  };
}

type BoundThread = Awaited<ReturnType<typeof createBoundThread>>;

function itemCompleted(item: RawItem, turnId = FINAL_TURN_ID): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "item/completed",
      params: { threadId: THREAD_ID, turnId, item },
    },
  } as AgentEvent;
}

function turnCompleted(turnId = FINAL_TURN_ID): AgentEvent {
  return {
    backend: "codex",
    notification: {
      method: "turn/completed",
      params: {
        threadId: THREAD_ID,
        turnId,
        turn: { id: turnId, status: "completed", completedAt: 2_000 },
      },
    },
  } as AgentEvent;
}

/** Feed the final turn's items, then turn/completed, as Codex streams them. */
async function finishTurn(thread: BoundThread, turn: RawTurn): Promise<void> {
  for (const item of turn.items) {
    if (item.type === "userMessage") {
      continue;
    }
    await thread.controller.handleBackendEvent(itemCompleted(item, turn.id));
  }
  await thread.controller.handleBackendEvent(turnCompleted(turn.id));
}

function deliveredImages(thread: { delivered: MessagingSurfaceIntent[] }): MessagingImagePart[] {
  return thread.delivered.flatMap((intent) =>
    intent.kind === "message"
      ? intent.parts.filter((part): part is MessagingImagePart => part.type === "image")
      : [],
  );
}

function historyTurns(count: number): RawTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    items: [
      { type: "userMessage", id: `user-${index}`, content: [{ type: "text", text: `Question ${index}` }] },
      { type: "agentMessage", id: `assistant-${index}`, phase: "final_answer", text: `Answer ${index}` },
    ],
  }));
}

function userItem(): RawItem {
  return { type: "userMessage", id: "user-final", content: [{ type: "text", text: "Show me the result." }] };
}

function finalAnswer(text: string, extra: RawItem = {}): RawItem {
  return { type: "agentMessage", id: "assistant-final", phase: "final_answer", text, ...extra };
}

function mcpScreenshot(): RawItem {
  return {
    type: "mcpToolCall",
    id: "mcp-screenshot",
    server: "pwrsnap",
    tool: "screenshot",
    status: "completed",
    arguments: {},
    result: { content: [{ type: "image", mimeType: "image/png", data: PNG_BASE64 }] },
  };
}

function writePng(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, name);
  writeFileSync(filePath, Buffer.from(PNG_BASE64, "base64"));
  return filePath;
}

describe("messaging final-reply images at a bound turn end", () => {
  it("reads no transcript page, and at most one turn", async () => {
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [userItem(), mcpScreenshot(), finalAnswer("Here is the screenshot.")],
    };
    const thread = await createBoundThread([...historyTurns(40), turn]);
    try {
      thread.codex.protocolReads.length = 0;
      await finishTurn(thread, turn);

      const pageReads = thread.codex.protocolReads.filter((method) => method === "readThread");
      expect(pageReads).toEqual([]);
      expect(thread.codex.protocolReads.filter((method) => method === "readThreadTurn").length)
        .toBeLessThanOrEqual(1);
      // The tool's screenshot still rides with the reply.
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
      ]);
    } finally {
      await thread.registry.close();
    }
  });

  // A budget, not a timing: each count is a pure function of the code path.
  // It fails when a turn end starts reading more, or when it reads less and
  // the budget goes stale.
  it.each([
    { label: "20-turn thread", history: 19 },
    { label: "2,000-turn thread", history: 1_999 },
  ])("keeps a fixed read budget per bound turn end on a $label", async ({ history }) => {
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [userItem(), mcpScreenshot(), finalAnswer("Here is the screenshot.")],
    };
    const thread = await createBoundThread([...historyTurns(history), turn]);
    try {
      thread.codex.protocolReads.length = 0;
      const turnsNormalizedBefore = thread.codex.turnsNormalized();
      for (const spy of [
        thread.imageRoots,
        thread.overlayParses,
        thread.pricingReads,
        thread.toolAccountingReads,
        thread.tokenMiserGateReads,
      ]) {
        spy.mockClear();
      }

      const { writes } = await measureSqliteWrites(async () => await finishTurn(thread, turn));

      expect({
        protocolReads: thread.codex.protocolReads,
        turnsNormalized: thread.codex.turnsNormalized() - turnsNormalizedBefore,
        imageRootLookups: thread.imageRoots.mock.calls.length,
        overlayParses: thread.overlayParses.mock.calls.length,
        pricingReads: thread.pricingReads.mock.calls.length,
        toolAccountingReads: thread.toolAccountingReads.mock.calls.length,
        tokenMiserGateReads: thread.tokenMiserGateReads.mock.calls.length,
        sqliteCommits: writes.commits,
      }).toEqual({
        protocolReads: ["readThreadTurn"],
        turnsNormalized: 1,
        // The screenshot is cached under the profile, which needs no approved
        // roots, so the thread's overlay is never parsed for images.
        imageRootLookups: 0,
        // turn/completed checks whether a queued message may start; that
        // admission check reads the overlay once. Image resolution adds none.
        overlayParses: 1,
        pricingReads: 0,
        toolAccountingReads: 0,
        tokenMiserGateReads: 0,
        sqliteCommits: 0,
      });
      expect(deliveredImages(thread)).toHaveLength(1);
    } finally {
      await thread.registry.close();
    }
  });

  it("delivers a Markdown-linked local image", async () => {
    const imagePath = writePng(path.join(workDir, "tmp-shots"), "chart.png");
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [userItem(), finalAnswer(`Chart:\n\n![Session chart](${imagePath})`)],
    };
    const thread = await createBoundThread([...historyTurns(3), turn]);
    try {
      await finishTurn(thread, turn);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({
          type: "image",
          alt: "Session chart",
          url: `data:image/png;base64,${PNG_BASE64}`,
        }),
      ]);
    } finally {
      await thread.registry.close();
    }
  });

  it("delivers a local image under the thread's approved roots, consulting them once", async () => {
    const project = path.join(workDir, "project");
    const imagePath = writePng(path.join(project, "shots"), "after.png");
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [userItem(), finalAnswer(`![After](${imagePath})`)],
    };
    const thread = await createBoundThread([...historyTurns(3), turn], { linkedDirectory: project });
    try {
      thread.imageRoots.mockClear();
      await finishTurn(thread, turn);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ alt: "After", url: `data:image/png;base64,${PNG_BASE64}` }),
      ]);
      expect(thread.imageRoots).toHaveBeenCalledTimes(1);
    } finally {
      await thread.registry.close();
    }
  });

  it("does not look up approved roots for a reply without images", async () => {
    const turn: RawTurn = { id: FINAL_TURN_ID, items: [userItem(), finalAnswer("All done.")] };
    const thread = await createBoundThread([...historyTurns(3), turn]);
    try {
      thread.imageRoots.mockClear();
      await finishTurn(thread, turn);
      expect(deliveredImages(thread)).toEqual([]);
      expect(thread.imageRoots).not.toHaveBeenCalled();
    } finally {
      await thread.registry.close();
    }
  });

  it("delivers an image-only final message", async () => {
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [
        userItem(),
        finalAnswer("", {
          content: [{ type: "output_image", image_url: "https://example.com/only.png", alt: "Only image" }],
        }),
      ],
    };
    const thread = await createBoundThread([...historyTurns(3), turn]);
    try {
      await finishTurn(thread, turn);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: "https://example.com/only.png", alt: "Only image" }),
      ]);
    } finally {
      await thread.registry.close();
    }
  });

  it("delivers a turn's tool screenshot when the turn wrote no reply", async () => {
    // Codex replay gives such a turn an image-only assistant message of its
    // own; turn/completed is the only event that can carry it.
    const turn: RawTurn = { id: FINAL_TURN_ID, items: [userItem(), mcpScreenshot()] };
    const thread = await createBoundThread([...historyTurns(3), turn]);
    try {
      await finishTurn(thread, turn);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
      ]);
    } finally {
      await thread.registry.close();
    }
  });

  it("still resolves the last reply's images on resume, which has no turn", async () => {
    const imagePath = writePng(path.join(workDir, "tmp-shots"), "resume.png");
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [userItem(), mcpScreenshot(), finalAnswer(`Resume view:\n\n![Resume](${imagePath})`)],
    };
    const thread = await createBoundThread([...historyTurns(3), turn]);
    try {
      const reply = await thread.bridge.readThreadLastAssistantReply({
        backend: "codex",
        threadId: THREAD_ID,
      });
      expect(reply?.text).toBe(`Resume view:\n\n![Resume](${imagePath})`);
      const images = await thread.bridge.resolveAssistantMessageImages({
        backend: "codex",
        text: reply!.text,
        threadId: THREAD_ID,
      });
      expect(images).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
        expect.objectContaining({ type: "image", alt: "Resume", url: `data:image/png;base64,${PNG_BASE64}` }),
      ]);
    } finally {
      await thread.registry.close();
    }
  });
});

// The same turn end for a thread a federation peer owns. The gateway that
// hosts the chat binding asked the owner for a 20-turn transcript page at
// every bound turn end, so the owner read and materialized 20 turns and the
// gateway parsed them all to find one message. An owner that advertises
// `turn_assistant_reply` answers with the finished turn's reply instead.
//
// These tests run the real owner registry and owner request handlers behind a
// real federation router, the real remote backend client on the gateway, and
// the real gateway messaging controller and bridge. Only the Codex client is
// fake.

const OWNER_INSTANCE_ID = "owner_one";
const GATEWAY_INSTANCE_ID = "gateway_one";
const OWNER_TARGET: FederationRemoteTarget = { scope: "remote", instanceId: OWNER_INSTANCE_ID };
const TURN_ASSISTANT_REPLY = "turn_assistant_reply" as FederationCapability;
const READ_THREAD = "backend.readThread";
const READ_TURN_REPLY = "backend.readTurnAssistantReply";
const READ_IMAGE = "backend.readTranscriptImage";

const overTheWire = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Turns whose content one owner response carried to the gateway. */
function turnsInPeerResult(method: string | undefined, result: unknown): number {
  if (method === READ_THREAD) {
    const entries = (result as { replay?: { entries?: Array<{ turn?: { id?: string } }> } })
      .replay?.entries ?? [];
    return new Set(entries.map((entry) => entry.turn?.id).filter(Boolean)).size;
  }
  if (method === READ_TURN_REPLY) {
    // The response is one turn's reply, or nothing.
    return (result as { message?: unknown }).message ? 1 : 0;
  }
  return 0;
}

async function createPeerBoundThread(
  turns: RawTurn[],
  options: { ownerAdvertisesTurnReply: boolean },
) {
  // The owner.
  const codex = createFakeCodexClient(turns);
  const store = new SqliteOverlayStore(db);
  setDesktopOverlayStoreForTests(store);
  const ownerRegistry = new DesktopBackendRegistry({
    codexClient: codex.client as never,
    overlayStore: store,
    messagingStore: null,
  });
  const tokenMiserStore = new TestTokenMiserStore(path.join(workDir, "token-miser"));
  (ownerRegistry as unknown as { tokenMiserStore: TestTokenMiserStore }).tokenMiserStore = tokenMiserStore;
  const ownerBridge = new DesktopMessagingBackendBridge(ownerRegistry);
  // An owner that predates the request has no handler for it.
  const ownerOperations = {
    readThread: async (request: Parameters<FederationBackendOperations["readThread"]>[0]) =>
      await readThreadForPeer(ownerRegistry, request),
    readTranscriptImage: async ({ url }: { url: string }) =>
      await readTranscriptImageProtocolRequest(url),
    resolveThreadAdmissionState: async (request: { backend: "codex"; threadId: string }) =>
      await ownerBridge.getThreadAdmissionState(request),
    ...(options.ownerAdvertisesTurnReply
      ? {
        readTurnAssistantReply: async (request: Parameters<typeof readTurnAssistantReplyForPeer>[1]) =>
          await readTurnAssistantReplyForPeer(ownerRegistry, request),
      }
      : {}),
  };

  // The wire between them.
  const methodsByRequestId = new Map<string, string>();
  const peerRequests: string[] = [];
  let turnsTransferred = 0;
  const router = new FederationRouter({
    localInstanceId: OWNER_INSTANCE_ID,
    methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
  });
  const rpc = new FederationRpcEndpoint({
    localInstanceId: GATEWAY_INSTANCE_ID,
    remoteInstanceId: OWNER_INSTANCE_ID,
    sendEnvelope: (envelope: FederationProtocolEnvelope) => {
      if (envelope.kind === "request") {
        methodsByRequestId.set(envelope.id, envelope.method);
        peerRequests.push(envelope.method);
      }
      void router.routeEnvelope({ sourcePeerId: GATEWAY_INSTANCE_ID, envelope: overTheWire(envelope) });
    },
  });
  router.registerConnection({
    peerId: GATEWAY_INSTANCE_ID,
    capabilities: ["thread_detail", "messaging_route"],
    sendEnvelope: (envelope: FederationProtocolEnvelope) => {
      if (envelope.kind === "response") {
        turnsTransferred += turnsInPeerResult(methodsByRequestId.get(envelope.requestId), envelope.result);
      }
      rpc.receiveEnvelope(overTheWire(envelope));
    },
  });
  registerFederationBackendHandlers({
    router,
    backend: ownerOperations as unknown as FederationBackendOperations,
  });

  // The gateway. Its own registry holds no copy of the thread.
  const remote = new FederationRemoteBackendClient(
    rpc,
    (response) => rewriteFederatedTranscriptImageUrlsForRenderer(response, OWNER_INSTANCE_ID),
  );
  const gatewayRegistry = {
    getThreadTranscriptImageRoots: vi.fn(async () => []),
    readThread: vi.fn(async () => {
      throw new Error("the gateway has no local copy of a peer thread");
    }),
    readThreadTurnReplay: vi.fn(async () => {
      throw new Error("the gateway has no local copy of a peer thread");
    }),
  };
  const federation = {
    connectedPeerTargets: () => [{
      target: OWNER_TARGET,
      label: "Owner",
      capabilities: [
        "messaging_route",
        "thread_detail",
        ...(options.ownerAdvertisesTurnReply ? [TURN_ASSISTANT_REPLY] : []),
      ] as FederationCapability[],
    }],
    remoteBackend: () => remote,
  } as unknown as DesktopMessagingFederationBridge;
  const bridge = new DesktopMessagingBackendBridge(
    gatewayRegistry as unknown as DesktopBackendRegistry,
    federation,
  );
  const messagingStore = new MessagingStore(path.join(workDir, "messaging-state.json"));
  await messagingStore.upsertBinding({
    id: "binding-peer",
    authorizedActorIds: ["user-1"],
    backend: "codex",
    channel: { channel: "telegram", conversation: { id: "chat-1", kind: "dm" } },
    createdAt: 1_000,
    federatedThread: { backend: "codex", target: OWNER_TARGET, threadId: THREAD_ID },
    targetKind: "thread",
    threadId: THREAD_ID,
    updatedAt: 1_000,
  });
  const delivered: MessagingSurfaceIntent[] = [];
  const controller = new MessagingController({
    adapter: {
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      deliver: async (intent) => {
        delivered.push(intent);
        return {
          channel: "telegram",
          deliveredAt: 1_000,
          outcome: "presented",
          surface: { channel: "telegram", id: `surface:${intent.id}` },
        };
      },
    },
    authorizedActorIds: ["user-1"],
    backend: bridge,
    inputDebounceMs: 0,
    now: () => 1_000,
    store: messagingStore,
  });
  return {
    bridge,
    codex,
    controller,
    delivered,
    gatewayRegistry,
    ownerRegistry,
    peerRequests,
    turnsTransferred: () => turnsTransferred,
  };
}

type PeerBoundThread = Awaited<ReturnType<typeof createPeerBoundThread>>;

/** The owner's events, as the gateway receives them from the peer. */
async function finishPeerTurn(thread: PeerBoundThread, turn: RawTurn): Promise<void> {
  for (const item of turn.items) {
    if (item.type === "userMessage") {
      continue;
    }
    await thread.controller.handleBackendEvent({
      ...itemCompleted(item, turn.id),
      federationTarget: OWNER_TARGET,
    });
  }
  await thread.controller.handleBackendEvent({
    ...turnCompleted(turn.id),
    federationTarget: OWNER_TARGET,
  });
}

function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

/** A tool screenshot and a Markdown-linked file on the owner's disk. */
function peerFinalTurn(): RawTurn {
  const imagePath = writePng(path.join(workDir, "owner-tmp-shots"), "chart.png");
  return {
    id: FINAL_TURN_ID,
    items: [userItem(), mcpScreenshot(), finalAnswer(`Here is the chart.\n\n![Chart](${imagePath})`)],
  };
}

describe("messaging final-reply images at a bound turn end on a peer-owned thread", () => {
  // A budget, not a timing: each count is a pure function of the code path.
  it.each([
    { history: 19, label: "20-turn thread" },
    { history: 1_999, label: "2,000-turn thread" },
  ].flatMap((size) => [
    {
      ...size,
      ownerAdvertisesTurnReply: true,
      peer: "an owner that advertises turn_assistant_reply",
      expected: {
        peerRequests: { [READ_TURN_REPLY]: 1, [READ_IMAGE]: 2, "backend.resolveThreadAdmissionState": 1 },
        turnsTransferred: 1,
        ownerProtocolReads: ["readThreadTurn"],
        ownerTurnsNormalized: 1,
      },
    },
    {
      ...size,
      ownerAdvertisesTurnReply: false,
      peer: "an owner that predates it",
      expected: {
        // The bridge until every peer advertises the request.
        peerRequests: { [READ_THREAD]: 1, [READ_IMAGE]: 2, "backend.resolveThreadAdmissionState": 1 },
        turnsTransferred: 20,
        ownerProtocolReads: ["readThread"],
        ownerTurnsNormalized: 20,
      },
    },
  ]))("keeps a fixed peer read budget per bound turn end on a $label, with $peer", async ({
    expected,
    history,
    ownerAdvertisesTurnReply,
  }) => {
    const turn = peerFinalTurn();
    const thread = await createPeerBoundThread(
      [...historyTurns(history), turn],
      { ownerAdvertisesTurnReply },
    );
    try {
      thread.codex.protocolReads.length = 0;
      const turnsNormalizedBefore = thread.codex.turnsNormalized();

      await finishPeerTurn(thread, turn);

      expect({
        peerRequests: countBy(thread.peerRequests),
        turnsTransferred: thread.turnsTransferred(),
        ownerProtocolReads: thread.codex.protocolReads,
        ownerTurnsNormalized: thread.codex.turnsNormalized() - turnsNormalizedBefore,
      }).toEqual(expected);
      expect(thread.gatewayRegistry.readThread).not.toHaveBeenCalled();
      expect(thread.gatewayRegistry.readThreadTurnReplay).not.toHaveBeenCalled();
      // Both images reach the chat as bytes the owner served.
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
        expect.objectContaining({ type: "image", alt: "Chart", url: `data:image/png;base64,${PNG_BASE64}` }),
      ]);
    } finally {
      await thread.ownerRegistry.close();
    }
  });

  it("delivers a peer turn's tool screenshot when the turn wrote no reply", async () => {
    const turn: RawTurn = { id: FINAL_TURN_ID, items: [userItem(), mcpScreenshot()] };
    const thread = await createPeerBoundThread(
      [...historyTurns(3), turn],
      { ownerAdvertisesTurnReply: true },
    );
    try {
      await finishPeerTurn(thread, turn);
      expect(thread.peerRequests).not.toContain(READ_THREAD);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
      ]);
    } finally {
      await thread.ownerRegistry.close();
    }
  });

  it("delivers a peer's image-only final message", async () => {
    const turn: RawTurn = {
      id: FINAL_TURN_ID,
      items: [
        userItem(),
        finalAnswer("", {
          content: [{ type: "output_image", image_url: "https://example.com/only.png", alt: "Only image" }],
        }),
      ],
    };
    const thread = await createPeerBoundThread(
      [...historyTurns(3), turn],
      { ownerAdvertisesTurnReply: true },
    );
    try {
      await finishPeerTurn(thread, turn);
      expect(thread.peerRequests).not.toContain(READ_THREAD);
      expect(deliveredImages(thread)).toEqual([
        expect.objectContaining({ type: "image", url: "https://example.com/only.png", alt: "Only image" }),
      ]);
    } finally {
      await thread.ownerRegistry.close();
    }
  });

  it("delivers nothing for a peer turn with no assistant output", async () => {
    const turn: RawTurn = { id: FINAL_TURN_ID, items: [userItem()] };
    const thread = await createPeerBoundThread(
      [...historyTurns(3), turn],
      { ownerAdvertisesTurnReply: true },
    );
    try {
      await finishPeerTurn(thread, turn);
      expect(thread.peerRequests).not.toContain(READ_THREAD);
      expect(deliveredImages(thread)).toEqual([]);
    } finally {
      await thread.ownerRegistry.close();
    }
  });

  it("still reads the last page for a peer's resume repost, which has no turn", async () => {
    const turn = peerFinalTurn();
    const thread = await createPeerBoundThread(
      [...historyTurns(3), turn],
      { ownerAdvertisesTurnReply: true },
    );
    try {
      const images = await thread.bridge.resolveAssistantMessageImages({
        backend: "codex",
        federationTarget: OWNER_TARGET,
        text: (turn.items[2] as { text: string }).text,
        threadId: THREAD_ID,
      });
      expect(countBy(thread.peerRequests)).toEqual({ [READ_THREAD]: 1, [READ_IMAGE]: 2 });
      expect(images).toEqual([
        expect.objectContaining({ type: "image", url: expect.stringMatching(/^data:image\/png;base64,/u) }),
        expect.objectContaining({ type: "image", alt: "Chart", url: `data:image/png;base64,${PNG_BASE64}` }),
      ]);
    } finally {
      await thread.ownerRegistry.close();
    }
  });
});

describe("transcript-only thread reads", () => {
  function createRegistry() {
    const objectsDir = path.join(workDir, "token-miser");
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
      registry,
    };
  }

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
