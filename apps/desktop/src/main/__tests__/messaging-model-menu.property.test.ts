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
  it.each([undefined, "@local/gpt-6-sol"])("keeps an existing Codex thread on its provider (%s)", (model) => {
    const models = [
      ...messagingModelCatalog,
      { id: "@local/gpt-6-sol", label: "Local Sol", providerId: "local", providerLabel: "Local" },
      { id: "@local/another", label: "Another", providerId: "local", providerLabel: "Local" },
    ];
    const expected = buildModelMenu({ kind: "codex", models, thread: { model } });
    const intent = buildStatusModelPickerIntent({
      binding, models, currentModelId: model, id: "model-picker", createdAt: 1,
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    });
    expect(intent.choices.filter((choice) => choice.id === "status:set-model")
      .map((choice) => (choice.value as { model: string }).model)).toEqual(expected.primary.map((entry) => entry.id));
  });

  it("keeps Claude's Other Models flag and its current selection on the second page", () => {
    const models = [{ id: "new", label: "New" }, { id: "old", label: "Old", other: true }];
    const render = (menuValue?: MessagingJsonValue) => buildStatusModelPickerIntent({
      binding: { ...binding, backend: "claude" }, models, currentModelId: "old", menuValue,
      id: "claude-picker", createdAt: 1, capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    });
    expect(render().choices.filter((choice) => choice.id === "status:set-model")).toHaveLength(1);
    const other = render().choices.find((choice) => choice.label === "Other Models")!;
    expect(other).toBeDefined();
    expect(render(other.value).choices).toContainEqual(expect.objectContaining({ label: "Old (current)" }));
  });

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
