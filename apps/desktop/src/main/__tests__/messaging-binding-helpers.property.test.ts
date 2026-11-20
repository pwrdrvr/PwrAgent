import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { MessagingBindingRecord } from "@pwragent/messaging-interface";
import { normalizeConversationTitle, describeConversation, handoffContextForBinding, threadContextForAdmissionState, isDefaultAgentRouteBinding } from "../messaging/core/messaging-binding-helpers";

const binding: MessagingBindingRecord = {
  id: "fixture-binding", backend: "codex", threadId: "fixture-thread", authorizedActorIds: ["fixture-actor"],
  createdAt: 1_000, updatedAt: 1_000, channel: { channel: "telegram", conversation: { kind: "dm", id: "fixture-conversation" } },
};
const thread: NavigationThreadSummary = {
  id: "fixture-thread", source: "codex", title: "Fixture thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
};

describe("messaging binding helper rules", () => {
  it("normalizes whitespace while keeping words and breadcrumb order", () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z]{1,8}$/), { maxLength: 5 }), fc.constantFrom(" ", "\n", "\t  "), fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()), (words, separator, included) => {
      expect(normalizeConversationTitle(` ${words.join(separator)} \n`)).toBe(words.length ? words.join(" ") : undefined);
      const titles = ["Fixture workspace", "Fixture parent", "Fixture conversation"].filter((_title, index) => included[index]);
      expect(describeConversation({ ...binding.channel.conversation,
        ancestorTitle: included[0] ? "Fixture workspace" : undefined,
        parentTitle: included[1] ? "Fixture parent" : undefined,
        title: included[2] ? "Fixture conversation" : undefined,
      })).toBe(titles.length ? titles.join(" / ") : "fixture-conversation");
    }));
  });

  it("projects targeted owner state without copying or widening it", () => {
    fc.assert(fc.property(fc.boolean(), present => {
      const state = { thread: present ? thread : undefined, threadStatus: "idle" as const };
      const projection = threadContextForAdmissionState(binding, state);
      expect(Object.keys(projection).sort()).toEqual(["kind", "thread"]);
      expect(projection.thread).toBe(state.thread);
      expect(projection.kind).toBe("thread");
    }));
  });

  it("keeps handoff backend/thread/path identity and observed branch precedence", () => {
    fc.assert(fc.property(fc.boolean(), fc.constantFrom("fixture-branch", "fixture-other"), (available, observed) => {
      const current = { ...thread, projectKey: "/fixture/repository", gitBranch: "stale-branch", observedGitBranch: observed,
        workspaceHandoff: { available },
      };
      const context = handoffContextForBinding(binding, { kind: "thread", thread: current });
      if (!available) expect(context).toBeUndefined();
      else expect(context).toMatchObject({ backend: "codex", threadId: "fixture-thread", repositoryPath: "/fixture/repository",
        workingDirectoryPath: "/fixture/repository", branch: observed, leaveLocalBranches: ["HEAD"], workspaceKind: "local" });
      expect(isDefaultAgentRouteBinding({ ...binding, id: available ? "default-agent-route:fixture" : "fixture-binding" })).toBe(available);
    }));
  });
});
