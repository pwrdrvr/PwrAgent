import { describe, expect, it } from "vitest";

import {
  ALL_MESSAGING_PERMISSIONS,
  permissionForActionId,
  permissionForCommandVerb,
} from "@pwragent/shared";

import { MESSAGING_COMMAND_CATALOG } from "../messaging/core/messaging-command-catalog";

/**
 * Drift guard: the desktop command catalog is the source of truth for the verb
 * set, and the status card renders a fixed set of `status:*` action ids. Both
 * must map to a permission in the shared lookup tables, or an unmapped
 * command/button would be silently ungated. This test lives in the desktop
 * package (not shared) because only here can it import the real catalog.
 */
describe("rbac permission coverage", () => {
  it("maps every command verb except help", () => {
    for (const spec of MESSAGING_COMMAND_CATALOG) {
      if (spec.verb === "help") {
        expect(permissionForCommandVerb(spec.verb)).toBeUndefined();
        continue;
      }
      const permission = permissionForCommandVerb(spec.verb);
      expect(permission, `verb ${spec.verb} must map to a permission`).toBeDefined();
      expect(ALL_MESSAGING_PERMISSIONS).toContain(permission);
    }
  });

  it("maps every status/handoff action the status card can render", () => {
    // Mirror the action ids emitted by messaging-status-card.ts and the
    // handoff sub-flow. If a new gated status action is added, add it here so
    // this test forces a permission mapping.
    const GATED_STATUS_ACTIONS = [
      "status:refresh",
      "status:detach",
      "status:model",
      "status:set-model",
      "status:reasoning",
      "status:set-reasoning",
      "status:fast",
      "status:tool-updates",
      "status:set-tool-updates",
      "status:streaming",
      "status:permissions",
      "status:set-permissions",
      "status:runtime-mode",
      "status:set-runtime-mode",
      "status:sync-name",
      "status:skills",
      "status:compact",
      "status:stop",
      "status:handoff",
      "handoff:confirm",
      "handoff:move-branch",
      "skills:select",
      "skills:remove",
      "skills:next",
      "skills:search",
    ];
    for (const actionId of GATED_STATUS_ACTIONS) {
      const permission = permissionForActionId(actionId);
      expect(permission, `${actionId} must map to a permission`).toBeDefined();
      expect(ALL_MESSAGING_PERMISSIONS).toContain(permission);
    }
  });
});
