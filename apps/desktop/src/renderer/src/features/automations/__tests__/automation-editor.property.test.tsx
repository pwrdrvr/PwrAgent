import { act, cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { describe, it } from "vitest";
import type { ReadDesktopMessagingSettingsResponse } from "@pwragent/shared/contracts/settings";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  codexCatalogArbitrary,
  expectModelSettingsToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";
import { openModelSettings } from "../../../test/model-settings";
import { AutomationEditor } from "../AutomationEditor";

function messagingSettings(): ReadDesktopMessagingSettingsResponse {
  const provider = () => ({
    enabled: { value: false },
    authorizedUserIds: { value: [] },
    authorizedConversations: { value: [] },
    authorizedChats: { value: [] },
    authorizedGroups: { value: [] },
    authorizedRooms: { value: [] },
  });
  return {
    snapshot: {
      messaging: {
        telegram: { ...provider(), authorizedSupergroups: { value: [] } },
        slack: { ...provider(), authorizedChannels: { value: [] } },
        discord: { ...provider(), authorizedGuilds: { value: [] } },
        mattermost: provider(),
        feishu: provider(),
        line: provider(),
      },
    },
  } as unknown as ReadDesktopMessagingSettingsResponse;
}

/**
 * The rule the automation editor broke: its model chip lists a catalog the
 * way the composer's does (`buildModelMenu`), after its own Inherit row.
 */
describe("automation editor model picker properties", () => {
  it("lists any Codex catalog by the shared model menu rule", async () => {
    await fc.assert(fc.asyncProperty(codexCatalogArbitrary, async (models) => {
      const desktopApi = {
        readMessagingSettings: async () => messagingSettings(),
        listBackends: async () => ({
          fetchedAt: 0,
          backends: [{
            kind: "codex",
            label: "Codex",
            available: true,
            methods: [],
            capabilities: {},
            executionModes: [],
            launchpadOptions: { models, reasoningEfforts: ["low", "medium", "high"] },
          }],
        }),
      } as unknown as DesktopApi;
      try {
        render(
          <AutomationEditor
            desktopApi={desktopApi}
            mode={{ assignment: { backend: "codex", threadId: "thread-1" }, kind: "create" }}
            onCancel={() => undefined}
            onSubmit={async () => undefined}
          />,
        );
        // Let the catalog read land before opening the chip.
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expectModelSettingsToList(openModelSettings("Automation model"), expectedModelDropdown({
          kind: "codex",
          models,
          leading: ["Inherit Agent model"],
          otherInline: true,
        }));
      } finally {
        cleanup();
      }
    }), { numRuns: 15 });
  });
});
