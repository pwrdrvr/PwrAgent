import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { describe, expect, it, vi } from "vitest";
import { subscribeGithubPrAuthenticationFailure } from "../github-pr-authentication-notice";
import {
  GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL,
  GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL,
} from "../../shared/ipc";

describe("GitHub authentication notice acknowledgement", () => {
  it("acknowledges only after an installed renderer consumer receives the event", () => {
    const emitter = new EventEmitter();
    const invoke = vi.fn(async () => {});
    const ipc = Object.assign(emitter, { invoke }) as unknown as IpcRenderer;
    const payload = { occurredAt: 123 };
    const send = () => emitter.emit(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL, {}, payload);
    send();
    expect(invoke).not.toHaveBeenCalled();
    const callback = vi.fn(() => expect(invoke).not.toHaveBeenCalled());
    const unsubscribe = subscribeGithubPrAuthenticationFailure(ipc, callback);
    expect(invoke).not.toHaveBeenCalled();
    send();
    expect(callback).toHaveBeenCalledExactlyOnceWith(payload);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(GITHUB_PR_AUTHENTICATION_FAILURE_ACK_CHANNEL);
    unsubscribe();
    send();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge when the renderer consumer throws", () => {
    const emitter = new EventEmitter();
    const invoke = vi.fn(async () => {});
    const ipc = Object.assign(emitter, { invoke }) as unknown as IpcRenderer;
    subscribeGithubPrAuthenticationFailure(ipc, () => { throw new Error("not received"); });
    expect(() => emitter.emit(GITHUB_PR_AUTHENTICATION_FAILURE_EVENT_CHANNEL, {}, { occurredAt: 123 }))
      .toThrow("not received");
    expect(invoke).not.toHaveBeenCalled();
  });
});
