import { describe, expect, it } from "vitest";
import { buildModelMenu } from "@pwragent/shared";
import type { MessagingBindingRecord, MessagingJsonValue } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { buildStatusModelPickerIntent } from "../messaging/core/messaging-status-card";
import { buildMessagingModelMenuActions } from "../messaging/core/messaging-model-menu";
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
  it("keeps every catalog entry reachable within the action budget", () => {
    for (const maxActions of [4, 5, 13, 20, 25, 100]) {
      for (const count of [1, 8, 9, 25, 65]) {
        const models = Array.from({ length: count }, (_, index) => ({ id: `model-${index}` }));
        const seen: string[] = [];
        let menuValue: MessagingJsonValue | undefined;
        for (let page = 0; page < count; page++) {
          const actions = buildMessagingModelMenuActions({
            kind: "codex", models, menuValue,
            menuActionId: "menu", selectActionId: "select",
            capabilityProfile: {
              ...PERMISSIVE_CAPABILITY_PROFILE,
              actions: { ...PERMISSIVE_CAPABILITY_PROFILE.actions!, maxActions },
            },
            backAction: { id: "back", label: "Back", priority: 1 },
          });
          expect(actions.length).toBeLessThanOrEqual(maxActions);
          expect(actions.some((action) => action.id === "back")).toBe(true);
          seen.push(...actions.filter((action) => action.id === "select")
            .map((action) => (action.value as { model: string }).model));
          const next = actions.find((action) => action.label === "Next");
          if (!next) break;
          menuValue = next.value;
        }
        expect(seen).toEqual(models.map((model) => model.id));
      }
    }
  });

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
