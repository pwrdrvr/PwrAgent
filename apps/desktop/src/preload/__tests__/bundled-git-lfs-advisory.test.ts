import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { describe, expect, it, vi } from "vitest";
import { subscribeBundledGitLfsAdvisory } from "../bundled-git-lfs-advisory";
import {
  BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL,
  BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL,
} from "../../shared/ipc";

describe("bundled Git LFS advisory acknowledgement", () => {
  it("acknowledges only after an installed renderer consumer receives the event", () => {
    const emitter = new EventEmitter();
    const invoke = vi.fn(async () => {});
    const ipc = Object.assign(emitter, { invoke }) as unknown as IpcRenderer;
    const payload = { occurredAt: 123, repositoryPath: "/repo" };
    const send = () => emitter.emit(BUNDLED_GIT_LFS_ADVISORY_EVENT_CHANNEL, {}, payload);
    send();
    expect(invoke).not.toHaveBeenCalled();
    const callback = vi.fn(() => expect(invoke).not.toHaveBeenCalled());
    const unsubscribe = subscribeBundledGitLfsAdvisory(ipc, callback);
    send();
    expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(BUNDLED_GIT_LFS_ADVISORY_ACK_CHANNEL);
    unsubscribe();
    send();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
