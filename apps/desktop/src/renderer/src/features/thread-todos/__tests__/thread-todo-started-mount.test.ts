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

/**
 * The rule, stated without the implementation: the operator started this
 * thread from this window, so a main window lists it unless it already lives
 * on this machine. The card's owner records its own start with no instance.
 * An instance named by the owner can be compared only with this machine's
 * known id.
 */
function expectedMountOwner(params: {
  owner: CardOwner;
  startedOn: StartedOn;
  remoteViewer: boolean;
  localKnown: boolean;
}): string | undefined {
  if (params.remoteViewer) return undefined;
  if (params.startedOn === "unset") return params.owner === "here" ? undefined : params.owner;
  if (!params.localKnown) return undefined;
  return params.startedOn === LOCAL ? undefined : params.startedOn;
}

describe("runThreadTodoAndMountStarted", () => {
  const owners: CardOwner[] = ["here", OWNER];
  const starts: StartedOn[] = ["unset", LOCAL, OWNER, THIRD];
  const cases = owners.flatMap((owner) => starts.flatMap((startedOn) =>
    [false, true].flatMap((remoteViewer) => [true, false].map((localKnown) =>
      ({ owner, startedOn, remoteViewer, localKnown })))));

  it.each(cases)(
    "card owned by $owner, started on $startedOn, remote viewer $remoteViewer, local id known $localKnown",
    async (params) => {
      const todo = card(params.owner, params.startedOn);
      const hasRemoteThreadPin = vi.fn(async () => false);
      const addRemoteThreadPin = vi.fn(async () => ({}) as never);
      const result = await runThreadTodoAndMountStarted(
        async () => todo,
        { hasRemoteThreadPin, addRemoteThreadPin },
        {
          localInstanceId: params.localKnown ? LOCAL : undefined,
          isRemoteViewer: params.remoteViewer,
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
      });
    },
  );

  it("leaves an already mounted thread alone", async () => {
    const addRemoteThreadPin = vi.fn();
    await runThreadTodoAndMountStarted(async () => card(OWNER, "unset"),
      { hasRemoteThreadPin: async () => true, addRemoteThreadPin },
      { localInstanceId: LOCAL, isRemoteViewer: false, instanceLabel: () => undefined });
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });

  it("resolves the run when the mount fails, since the thread already exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const todo = card(OWNER, "unset");
    await expect(runThreadTodoAndMountStarted(async () => todo,
      { hasRemoteThreadPin: async () => false, addRemoteThreadPin: async () => { throw new Error("offline"); } },
      { localInstanceId: LOCAL, isRemoteViewer: false, instanceLabel: () => undefined })).resolves.toBe(todo);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("mounts nothing when the run fails", async () => {
    const addRemoteThreadPin = vi.fn();
    await expect(runThreadTodoAndMountStarted(async () => { throw new Error("refused"); },
      { hasRemoteThreadPin: async () => false, addRemoteThreadPin },
      { localInstanceId: LOCAL, isRemoteViewer: false, instanceLabel: () => undefined })).rejects.toThrow("refused");
    expect(addRemoteThreadPin).not.toHaveBeenCalled();
  });
});
