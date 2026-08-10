import fs from "node:fs";
import { fileURLToPath } from "node:url";

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
      "status:response-mode",
      "status:set-response-mode",
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

  it("maps every status:* literal that appears in the status-card source", () => {
    // Belt to the curated list's suspenders: scan the status card's source for
    // `"status:..."` id literals so a brand-new button cannot ship ungated
    // just because nobody added it to GATED_STATUS_ACTIONS above. Prefix-gated
    // families (handoff:/skills:/questionnaire:) don't need scanning — the
    // permissionForActionId prefix rules cover any id in those namespaces.
    const source = fs.readFileSync(
      fileURLToPath(
        new URL("../messaging/core/messaging-status-card.ts", import.meta.url),
      ),
      "utf8",
    );
    const ids = new Set(
      [...source.matchAll(/"(status:[a-z0-9_-]+)"/g)].map((match) => match[1]),
    );
    // Sanity: the scan actually found the card's buttons (regex not stale).
    expect(ids.size).toBeGreaterThanOrEqual(15);
    for (const actionId of ids) {
      const permission = permissionForActionId(actionId);
      expect(permission, `${actionId} must map to a permission`).toBeDefined();
      expect(ALL_MESSAGING_PERMISSIONS).toContain(permission);
    }
  });
});
