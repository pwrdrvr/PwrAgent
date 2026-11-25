import fc from "fast-check";
import type { CreateScheduledThreadActionRequest } from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { beforeEach, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const serviceMock = vi.hoisted(() => ({
  create: vi.fn(async (request: unknown) => ({ action: request })),
}));
const remoteBackendMock = vi.hoisted(() => ({
  createScheduledThreadAction: vi.fn(async (request: unknown) => ({ action: request })),
}));
const remoteBackend = vi.hoisted(() => vi.fn(() => remoteBackendMock));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../scheduled-actions/scheduled-thread-action-service", () => ({
  getScheduledThreadActionService: vi.fn(() => serviceMock),
}));

vi.mock("../federation/federation-runtime", () => ({
  getDesktopFederationRuntime: vi.fn(() => ({ remoteBackend })),
}));

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

function ownerCard(id: string): ThreadTodo {
  return {
    id, backend: "codex", threadId: "thread-1", kind: "review", status: "open",
    title: "Review #12", createdAt: 0, updatedAt: 0, action: { type: "start_review" },
  };
}

function queueReview(todoId: string, federationTarget: CreateScheduledThreadActionRequest["federationTarget"]) {
  return {
    backend: "codex" as const,
    threadId: "thread-1",
    kind: "review" as const,
    scheduledFor: 0,
    displayText: "Review PR #12",
    federationTarget,
    review: { target: { type: "uncommittedChanges" as const }, todo: { id: todoId, allowOpenItems: true } },
  } satisfies CreateScheduledThreadActionRequest;
}

const instanceId = fc.string({ minLength: 1, maxLength: 12 });
const cardId = fc.string({ minLength: 1, maxLength: 24 });

// Oracle: the owner completes a started review's card by looking its id up
// among its own cards. A review a viewer queues from a peer's card has to
// carry an id that lookup finds, whatever characters either id holds.
it("hands the owner its own id for a card queued from a peer's view", async () => {
  const { projectRemoteThreadTodo } = await import("../federation/federation-thread-todos");
  const { registerScheduledActionIpcHandlers } = await import("../shell/ipc/scheduled-actions-ipc");
  const { SCHEDULED_ACTIONS_CREATE_CHANNEL } = await import("../../shared/ipc");
  registerScheduledActionIpcHandlers();
  const create = handlers.get(SCHEDULED_ACTIONS_CREATE_CHANNEL)!;

  await fc.assert(fc.asyncProperty(instanceId, fc.uniqueArray(cardId, { minLength: 1, maxLength: 4 }), fc.nat(),
    async (owner, ids, pick) => {
      remoteBackendMock.createScheduledThreadAction.mockClear();
      const target = { scope: "remote" as const, instanceId: owner };
      const cards = ids.map(ownerCard);
      const card = cards[pick % cards.length]!;
      const seen = projectRemoteThreadTodo(card, target, undefined);

      await create({}, queueReview(seen.id, target));

      const sent = remoteBackendMock.createScheduledThreadAction.mock.calls[0]?.[0] as CreateScheduledThreadActionRequest;
      expect(sent.federationTarget).toBeUndefined();
      expect(cards.find((candidate) => candidate.id === sent.review?.todo?.id)).toBe(card);
      expect(sent.review?.todo?.allowOpenItems).toBe(true);
    }));
});

it("refuses a card another peer owns, and leaves a local card's id alone", async () => {
  const { projectRemoteThreadTodo } = await import("../federation/federation-thread-todos");
  const { registerScheduledActionIpcHandlers } = await import("../shell/ipc/scheduled-actions-ipc");
  const { SCHEDULED_ACTIONS_CREATE_CHANNEL } = await import("../../shared/ipc");
  registerScheduledActionIpcHandlers();
  const create = handlers.get(SCHEDULED_ACTIONS_CREATE_CHANNEL)!;

  await fc.assert(fc.asyncProperty(instanceId, instanceId, cardId, async (owner, other, id) => {
    fc.pre(owner !== other);
    remoteBackendMock.createScheduledThreadAction.mockClear();
    serviceMock.create.mockClear();
    const elsewhere = projectRemoteThreadTodo(ownerCard(id), { scope: "remote", instanceId: other }, undefined);

    await expect(create({}, queueReview(elsewhere.id, { scope: "remote", instanceId: owner }))).rejects.toThrow(
      "To-do owner does not match its target.",
    );
    expect(remoteBackendMock.createScheduledThreadAction).not.toHaveBeenCalled();

    await create({}, queueReview(id, undefined));
    const local = serviceMock.create.mock.calls[0]?.[0] as CreateScheduledThreadActionRequest | undefined;
    expect(local?.review?.todo?.id).toBe(id);
  }));
});
