import { describe, expect, it } from "vitest";
import { buildModelMenu } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingJsonValue } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { buildStatusModelPickerIntent } from "../messaging/core/messaging-status-card";
import { messagingModelCatalog } from "./fixtures/messaging-model-catalog";

const binding: MessagingBindingRecord = {
  id: "model-menu-binding",
  backend: "codex",
  channel: { channel: "telegram", conversation: { id: "fixture-chat", kind: "dm" } },
  threadId: "fixture-thread",
  authorizedActorIds: ["fixture-user"],
  createdAt: 1,
  updatedAt: 1,
};

describe("messaging model menu oracle", () => {
  it("matches the desktop menu for every subset of the Codex catalog", () => {
    // The shared desktop rule owns classification and catalog order. Removing
    // replacements must also restore older models to the primary menu.
    for (let mask = 1; mask < 1 << messagingModelCatalog.length; mask++) {
      const models = messagingModelCatalog.filter((_, index) => mask & (1 << index));
      const expected = buildModelMenu({ kind: "codex", models, thread: { model: models[0]!.id } });
      const render = (menuValue?: MessagingJsonValue) => buildStatusModelPickerIntent({
        binding, models, currentModelId: models[0]!.id, menuValue,
        id: "model-picker", createdAt: 1, capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      });
      const primary = render();
      expect(primary.choices.filter((choice) => choice.id === "status:set-model")
        .map((choice) => (choice.value as { model: string }).model)).toEqual(expected.primary.map((model) => model.id));
      const other = primary.choices.find((choice) => choice.label === "Other");
      expect(Boolean(other)).toBe(expected.other.length > 0);
      if (other) {
        expect(render(other.value).choices.filter((choice) => choice.id === "status:set-model")
          .map((choice) => (choice.value as { model: string }).model)).toEqual(expected.other.map((model) => model.id));
      }
    }
  });
});
