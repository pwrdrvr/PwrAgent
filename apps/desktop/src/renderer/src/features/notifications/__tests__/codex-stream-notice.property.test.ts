import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AppServerBackendKind, FederationInstanceId } from "@pwragent/shared";
import { resolveCodexStreamNotice } from "../codex-stream-notice";

describe("stream notice navigation", () => {
  it("links retries and recovery to the visible owner while keeping incidents separate by worker", () => {
    fc.assert(fc.property(
      fc.constantFrom<AppServerBackendKind>("codex", "claude", "acp:grok"),
      fc.option(fc.uuid(), { nil: undefined }),
      fc.string({ minLength: 1 }).filter((value) => value.trim().length > 0),
      (ownerBackend, instance, title) => {
        const instanceId = instance as FederationInstanceId | undefined;
        const owner = { backend: ownerBackend, threadId: "owner", title };
        const noticeFor = (threadId: string) => resolveCodexStreamNotice({
          backend: "codex",
          instanceId,
          errorNoticeContext: owner,
          threadLabel: "Codex worker",
          notification: {
            method: "error",
            params: { threadId, turnId: "turn", willRetry: true, error: { message: "Reconnecting" } },
          },
        }, []);
        const first = noticeFor("worker-1");
        const second = noticeFor("worker-2");
        expect(first).toMatchObject({ notice: {
          detail: title,
          threadLink: { ...owner, ...(instanceId ? { instanceId } : {}) },
        } });
        if (!first || !("notice" in first) || !second || !("notice" in second)) throw new Error("Expected retry notices");
        expect(first.notice.id).not.toBe(second.notice.id);
        expect(resolveCodexStreamNotice({
          instanceId,
          threadLabel: "Codex worker",
          notification: { method: "item/agentMessage/delta", params: { threadId: "worker-1", turnId: "turn", delta: "Resumed" } },
        }, [first.notice, second.notice])).toMatchObject({ notice: {
          id: first.notice.id,
          title: "Codex resumed",
          detail: title,
          threadLink: first.notice.threadLink,
        } });
      },
    ));
  });

  it("keeps the Job Monitor owner's link when recovery arrives without owner metadata", () => {
    const retry = resolveCodexStreamNotice({
      threadLabel: "Branch manager",
      errorNoticeContext: { backend: "codex", threadId: "parent" },
      notification: { method: "error", params: {
        threadId: "monitor", turnId: "turn", willRetry: true, error: { message: "Reconnecting" },
      } },
    }, []);
    if (!retry || !("notice" in retry)) throw new Error("Expected retry notice");
    expect(resolveCodexStreamNotice({
      threadLabel: "Codex thread monitor",
      notification: { method: "item/agentMessage/delta", params: {
        threadId: "monitor", turnId: "turn", delta: "Recovered",
      } },
    }, [retry.notice])).toMatchObject({ notice: {
      title: "Codex resumed",
      detail: "Branch manager",
      threadLink: { backend: "codex", threadId: "parent", title: "Branch manager" },
    } });
  });
});
