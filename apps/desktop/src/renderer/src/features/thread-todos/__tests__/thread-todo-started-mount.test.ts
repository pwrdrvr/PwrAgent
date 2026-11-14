import { describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import { runThreadTodoAndMountStarted } from "../thread-todo-started-mount";

const LOCAL = "pwr_local";
const OWNER = "pwr_owner";
const THIRD = "pwr_third";

type CardOwner = "here" | typeof OWNER;
type StartedOn = "unset" | typeof LOCAL | typeof OWNER | typeof THIRD;

function card(owner: CardOwner, startedOn: StartedOn): ThreadTodo {
  return {
    id: "todo-1",
    backend: "claude",
    threadId: "raising",
    status: "done",
    title: "Hand off",
    createdAt: 1,
    updatedAt: 2,
    ...(owner === "here" ? {} : { federationTarget: { scope: "remote", instanceId: owner } }),
    startedThread: {
      backend: "claude",
      threadId: "started",
      ...(startedOn === "unset" ? {} : { instanceId: startedOn, instanceLabel: `${startedOn} label` }),
    },
  } as ThreadTodo;
}

type WindowKind = "main" | typeof OWNER;

/**
 * The rule, stated without the implementation: the operator started this
 * thread from this machine, so this machine lists it. A thread on this
 * machine is listed already, and so is one on the peer a remote viewer
 * window shows. The card's owner records its own start with no instance. An
 * instance named by the owner can be compared only with this machine's known
 * id.
 */
function expectedMountOwner(params: {
  owner: CardOwner;
  startedOn: StartedOn;
  window: WindowKind;
  localKnown: boolean;
}): string | undefined {
  const livesOn = params.startedOn === "unset"
    ? (params.owner === "here" ? LOCAL : params.owner)
    : (params.localKnown ? params.startedOn : undefined);
  if (!livesOn || livesOn === LOCAL || livesOn === params.window) return undefined;
  return livesOn;
}

describe("runThreadTodoAndMountStarted", () => {
  const owners: CardOwner[] = ["here", OWNER];
  const starts: StartedOn[] = ["unset", LOCAL, OWNER, THIRD];
  // A remote viewer window shows only its owner's cards.
  const windows = (owner: CardOwner): WindowKind[] => owner === "here" ? ["main"] : ["main", OWNER];
  const cases = owners.flatMap((owner) => starts.flatMap((startedOn) =>
    windows(owner).flatMap((window) => [true, false].map((localKnown) =>
      ({ owner, startedOn, window, localKnown })))));

  it.each(cases)(
    "card owned by $owner, started on $startedOn, in the $window window, local id known $localKnown",
    async (params) => {
      const todo = card(params.owner, params.startedOn);
      const hasRemoteThreadPin = vi.fn(async () => false);
      const addRemoteThreadPin = vi.fn(async () => ({}) as never);
      const result = await runThreadTodoAndMountStarted(
        async () => todo,
        { hasRemoteThreadPin, addRemoteThreadPin },
        {
          localInstanceId: params.localKnown ? LOCAL : undefined,
          windowOwnerInstanceId: params.window === "main" ? undefined : params.window,
          instanceLabel: (instanceId) => `${instanceId} from peers`,
        },
      );
      expect(result).toBe(todo);
      const owner = expectedMountOwner(params);
      if (!owner) {
        expect(addRemoteThreadPin).not.toHaveBeenCalled();
        return;
      }
      const startedLabel = params.startedOn === "unset" ? undefined : `${params.startedOn} label`;
      expect(addRemoteThreadPin).toHaveBeenCalledTimes(1);
      expect(addRemoteThreadPin).toHaveBeenCalledWith({
        ref: { backend: "claude", threadId: "started", target: { scope: "remote", instanceId: owner } },
        instanceLabel: startedLabel ?? `${owner} from peers`,
        summary: {
          source: "claude", id: "started", title: "Hand off", titleSource: "fallback",
          linkedDirectories: [], inbox: { inInbox: false },
        },
      });
    },
  );

  it("names the pinned row for the card's thread title until the owner's snapshot arrives", async () => {
    const addRemoteThreadPin = vi.fn(async () => ({}) as never);
    const todo = { ...card(OWNER, "unset"), action: { type: "start_thread", prompt: "Go", title: "Registry split" } } as ThreadTodo;
    await runThreadTodoAndMountStarted(async () => todo,
      { hasRemoteThreadPin: async () => false, addRemoteThreadPin },
      { localInstanceId: LOCAL, windowOwnerInstanceId: undefined, instanceLabel: () => undefined });
    expect(addRemoteThreadPin).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.objectContaining({ title: "Registry split", id: "started" }),
    }));
    const [pinned] = addRemoteThreadPin.mock.calls[0] as unknown as [{ summary: object }];
    expect(pinned.summary).not.toHaveProperty("parentThreadId");
  });

  it("leaves an already mounted thread alone", async () => {
    const addRemoteThreadPin = vi.fn();
    await runThreadTodoAndMountStarted(async () => card(OWNER, "unset"),
      { hasRemoteThreadPin: async () => true, addRemoteThreadPin },
      { localInstanceId: LOCAL, windowOwnerInstanceId: undefined, instanceLabel: () => undefined });
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });

  it("resolves the run when the mount fails, since the thread already exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const todo = card(OWNER, "unset");
    await expect(runThreadTodoAndMountStarted(async () => todo,
      { hasRemoteThreadPin: async () => false, addRemoteThreadPin: async () => { throw new Error("offline"); } },
      { localInstanceId: LOCAL, windowOwnerInstanceId: undefined, instanceLabel: () => undefined })).resolves.toBe(todo);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mounts nothing when the run fails", async () => {
    const addRemoteThreadPin = vi.fn();
    await expect(runThreadTodoAndMountStarted(async () => { throw new Error("refused"); },
      { hasRemoteThreadPin: async () => false, addRemoteThreadPin },
      { localInstanceId: LOCAL, windowOwnerInstanceId: undefined, instanceLabel: () => undefined })).rejects.toThrow("refused");
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });
});
