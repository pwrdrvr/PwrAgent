import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingBindingRecord, MessagingBrowseSessionRecord } from "@pwragent/messaging-interface";
import { fullAccessRiskPresentationForContext, normalizeMessagingFullAccessControls } from "../messaging/core/messaging-access-helpers";

describe("messaging access policy helpers", () => {
  it("defaults absent controls and retains explicit false values and contact callbacks", () => {
    fc.assert(fc.property(fc.option(fc.boolean(), { nil: undefined }), fc.option(fc.boolean(), { nil: undefined }), (allowEscalation, allowThreadResume) => {
      const dismissWarning = async () => {};
      const authorizedUsers = { telegram: [{ id: "fixture-actor", displayName: "Fixture actor" }] };
      const controls = normalizeMessagingFullAccessControls({ allowEscalation: allowEscalation ?? true, allowThreadResume: allowThreadResume ?? true,
        warningPolicy: "never", authorizedUsers, dismissWarning,
      });
      expect(controls).toMatchObject({ allowEscalation: allowEscalation ?? true, allowThreadResume: allowThreadResume ?? true, warningPolicy: "never" });
      expect(controls.authorizedUsers).toBe(authorizedUsers);
      expect(controls.dismissWarning).toBe(dismissWarning);
      expect(normalizeMessagingFullAccessControls(undefined)).toEqual({ allowEscalation: true, allowThreadResume: true, warningPolicy: "dismissable",
        authorizedUsers: {}, dismissWarning: undefined, canDismissWarning: undefined,
      });
    }));
  });

  it("uses only the selected presentation surface and gives the live status precedence over its pin", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.constantFrom("message", "surface"), (live, pinned, mode) => {
      const channel = { channel: "telegram" as const, conversation: { id: "fixture-chat", kind: "dm" as const } };
      const binding: MessagingBindingRecord = { id: "fixture-binding", backend: "codex", threadId: "fixture-thread", channel, authorizedActorIds: [], createdAt: 1, updatedAt: 1,
        ...(live ? { statusSurface: { channel: "telegram", id: "live" } } : {}),
        ...(pinned ? { pinnedStatusSurface: { channel: "telegram", id: "pin" } } : {}),
      };
      const session: MessagingBrowseSessionRecord = { id: "fixture-picker", allowedActorIds: [], channel, createdAt: 1, updatedAt: 1, expiresAt: 2,
        launchAction: "start_new_thread", mode: "projects", pageIndex: 0, pageSize: 5, surface: { channel: "telegram", id: "picker" },
      };
      const thread = fullAccessRiskPresentationForContext({ kind: "thread", backend: "codex", threadId: binding.threadId, binding }, mode);
      expect(thread.surface?.id).toBe(mode === "message" ? undefined : live ? "live" : pinned ? "pin" : undefined);
      expect(thread.binding).toBe(mode === "message" ? undefined : binding);
      expect(fullAccessRiskPresentationForContext({ kind: "new-thread", session }, mode).surface?.id).toBe(mode === "message" ? undefined : "picker");
    }));
  });
});
