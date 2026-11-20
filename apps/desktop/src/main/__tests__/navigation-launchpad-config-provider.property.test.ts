import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  applyNavigationLaunchpadProviderModelDefaults,
  navigationLaunchpadProviderKey,
  projectNavigationLaunchpadProviderSettings,
  type NavigationLaunchpadDraft,
} from "@pwragent/shared/contracts/navigation";

const stored = vi.hoisted(() => ({ launchpad: undefined as NavigationLaunchpadDraft | undefined }));
vi.mock("../storage/desktop-overlay-store", () => ({
  getDesktopOverlayStore: () => ({
    getLaunchpadDefaults: async () => ({ backend: "codex", executionMode: "auto" }),
    getDirectoryLaunchpad: async () => stored.launchpad,
  }),
}));

import { NavigationDetailService, type NavigationDetailRegistry } from "../app-server/navigation-detail-service";

// These drafts have no directory path, so configuration reads need no Git or environment inspection.
const service = new NavigationDetailService({} as NavigationDetailRegistry);

async function expectProviderRoundTrip(provider: string, reset: boolean): Promise<void> {
  const key = `codex-provider:${provider}`;
  const draft = projectNavigationLaunchpadProviderSettings<NavigationLaunchpadDraft>({
    backend: "codex", model: `@${provider}/model`, executionMode: "auto",
    directoryKey: "directory:fixture", directoryKind: "directory", directoryLabel: "Fixture",
    prompt: "unsent", workMode: "local", createdAt: 1, updatedAt: 1,
  });
  stored.launchpad = reset ? applyNavigationLaunchpadProviderModelDefaults(draft, {}, [key]) : draft;
  const response = await service.readLaunchpadConfig({ protocol: 2, directoryKey: draft.directoryKey });
  const wire = JSON.parse(JSON.stringify(response)) as typeof response;
  expect(wire.launchpad?.codexModelProviderId).toBe(provider);
  const restored = projectNavigationLaunchpadProviderSettings({ ...wire.launchpad!, prompt: "unsent" });
  expect(navigationLaunchpadProviderKey(restored)).toBe(key);
  expect(restored.model).toBe(reset ? undefined : draft.model);
}

describe("launchpad configuration provider round trip", () => {
  it("preserves any endpoint identity with or without a selected model", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1000 }), fc.boolean(), async (id, reset) => {
      await expectProviderRoundTrip(`endpoint-${id}`, reset);
    }));
  });

  it("keeps MathOS selected after its model default is reset", async () => {
    await expectProviderRoundTrip("mathos", true);
  });

  it("changes the configuration revision when only the selected endpoint changes", async () => {
    await expectProviderRoundTrip("mathos", true);
    const request = { protocol: 2 as const, directoryKey: stored.launchpad!.directoryKey };
    const first = await service.readLaunchpadConfig(request);
    stored.launchpad = { ...stored.launchpad!, codexModelProviderId: "bonsai" };
    const changed = await service.readLaunchpadConfig({ ...request, knownRevision: first.revision });
    expect(changed.unchanged).not.toBe(true);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.launchpad?.codexModelProviderId).toBe("bonsai");
  });
});
