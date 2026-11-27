import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import { splitGraphemes } from "@pwragent/shared/text-graphemes";
import {
  SUB_AGENT_ACTIVITY_TAIL_CHARS,
  applySubAgentActivityEvent,
  resetSubAgentActivityStore,
  splitSubAgentActivity,
} from "../sub-agent-activity";

// A renderer window; a viewer window also names the peer it fronts.
let rendererWindow: { __pwragentFederationTarget?: unknown };
beforeEach(() => {
  rendererWindow = {};
  vi.stubGlobal("window", rendererWindow);
});
afterEach(() => {
  resetSubAgentActivityStore();
  vi.unstubAllGlobals();
});

const event = (threadId: string, activities: { monitorId: string; activity: string }[], instanceId?: string): AgentEvent => ({
  backend: "claude",
  ...(instanceId ? { federationTarget: { scope: "remote" as const, instanceId } } : {}),
  notification: { method: "thread/subAgentActivity/updated", params: { threadId, activities } },
});

describe("sub-agent activity store", () => {
  it("replaces a thread's set, reports only real changes, and forgets an empty set", () => {
    const line = [{ monitorId: "claude-native:a", activity: "Reading app.css" }];
    expect(applySubAgentActivityEvent(event("t1", line))).toBe(true);
    expect(applySubAgentActivityEvent(event("t1", line))).toBe(false);
    // The same thread id on another machine is another thread.
    expect(applySubAgentActivityEvent(event("t1", line, "peer"))).toBe(true);
    expect(applySubAgentActivityEvent(event("t1", []))).toBe(true);
    expect(applySubAgentActivityEvent(event("t1", []))).toBe(false);
    expect(applySubAgentActivityEvent({ backend: "claude", notification: {
      method: "thread/backgroundTasks/updated", params: { threadId: "t1", tasks: [] },
    } })).toBe(false);
  });

  it("keys a viewer window's events by the window's peer, as its rows are", () => {
    rendererWindow.__pwragentFederationTarget = { scope: "remote", instanceId: "peer" };
    const line = [{ monitorId: "claude-native:a", activity: "Reading app.css" }];
    // Relayed without a target, it still lands on the peer's row key.
    expect(applySubAgentActivityEvent(event("t1", line))).toBe(true);
    expect(applySubAgentActivityEvent(event("t1", line, "peer"))).toBe(false);
  });
});

describe("splitSubAgentActivity", () => {
  // Paths, CJK, combining marks, and ZWJ emoji: the cut must never tear a glyph.
  const piece = fc.constantFrom("/", "Users", " ", "déjà", "東京", "👩🏽‍💻", "app.css", "-", "é");
  const line = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(""));

  it("keeps the whole line, and splits only a line naming a path, between glyphs", () => {
    fc.assert(fc.property(line, (text) => {
      const { head, tail } = splitSubAgentActivity(text);
      expect(head + tail).toBe(text);
      if (!text.includes("/")) {
        expect(tail).toBe("");
        return;
      }
      const clusters = splitGraphemes(text);
      const tailClusters = splitGraphemes(tail);
      expect(tailClusters.length).toBe(Math.min(SUB_AGENT_ACTIVITY_TAIL_CHARS, Math.floor(clusters.length / 2)));
      // Cut on a cluster boundary: the head's clusters plus the tail's are the line's.
      expect([...splitGraphemes(head), ...tailClusters]).toEqual(clusters);
    }));
  });
});
