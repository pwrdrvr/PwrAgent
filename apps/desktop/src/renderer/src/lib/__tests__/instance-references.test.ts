import { describe, expect, it } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import {
  buildInstanceReferenceMarkdown,
  buildInstanceReferenceUrl,
  filterAtReferenceCandidates,
  listInstanceReferences,
  parseInstanceReferenceUrl,
} from "../instance-references";
import { hydrateComposerDraft } from "../../features/composer/composer-draft-hydration";
import { createComposerAtReferenceToken, serializeDraftWithSkillTokens } from "../../features/composer/composer-mention-tokens";

const health: FederationHealthStatus = {
  enabled: true,
  role: "gateway",
  status: "connected",
  instanceId: "local-default",
  localLabel: "Studio",
  localProfileName: "default",
  peers: [
    { id: "studio-dev", label: "Studio", profileName: "dev", role: "client", status: "connected", capabilities: [] },
    { id: "windows-dev", label: "DESKTOP-LAB", profileName: "dev", role: "client", status: "disconnected", capabilities: [], host: { hostname: "windows-lab" } },
    { id: "revoked", label: "Old machine", role: "client", status: "revoked", capabilities: [] },
  ],
};

describe("Federation @ references", () => {
  it("keeps local and remote profiles distinct and includes offline enrolled peers", () => {
    expect(listInstanceReferences(health).map(({ label, path }) => ({ label, path }))).toEqual([
      { label: "Studio / default", path: "pwragent://instance/local-default" },
      { label: "Studio / dev", path: "pwragent://instance/studio-dev" },
      { label: "DESKTOP-LAB / dev", path: "pwragent://instance/windows-dev" },
    ]);
    expect(listInstanceReferences({ ...health, enabled: false })).toEqual([]);
  });

  it("carries each machine's federation short name beside its full label", () => {
    const named: FederationHealthStatus = {
      enabled: true,
      role: "gateway",
      status: "connected",
      instanceId: "mini-2",
      localLabel: "Lab-Mac-Mini-2",
      localProfileName: "default",
      localShortLabel: "Mini 2",
      peers: [
        { id: "mini-1", label: "Lab-Mac-Mini-1", profileName: "default", shortLabel: "Mini 1", role: "client", status: "connected", capabilities: [] },
        { id: "mini-1-dev", label: "Lab-Mac-Mini-1", profileName: "dev", shortLabel: "Mini 1", role: "client", status: "disconnected", capabilities: [] },
        { id: "unnamed", label: "DESKTOP-LAB", profileName: "default", role: "client", status: "connected", capabilities: [] },
      ],
    };
    expect(listInstanceReferences(named).map(({ label, shortLabel }) => ({ label, shortLabel }))).toEqual([
      // A lone default profile drops its suffix, as on every other face.
      { label: "Lab-Mac-Mini-2 / default", shortLabel: "Mini 2" },
      { label: "Lab-Mac-Mini-1 / default", shortLabel: "Mini 1 / default" },
      { label: "Lab-Mac-Mini-1 / dev", shortLabel: "Mini 1 / dev" },
      { label: "DESKTOP-LAB / default", shortLabel: undefined },
    ]);
    for (const [query, instanceId] of [["mini 2", "mini-2"], ["Mini 1/dev", "mini-1-dev"], ["lab-mac-mini-1", "mini-1"]]) {
      expect(filterAtReferenceCandidates([], listInstanceReferences(named), query))
        .toContainEqual(expect.objectContaining({ instanceId }));
    }
  });

  it.each(["desk", "DEV", "windows-lab", "windows-dev", "DESKTOP-LAB/dev"])("searches machines, profiles, hostnames and IDs with %s", (query) => {
    expect(filterAtReferenceCandidates([], listInstanceReferences(health), query))
      .toContainEqual(expect.objectContaining({ instanceId: "windows-dev" }));
  });

  it("reserves space for instances even with ten matching projects", () => {
    const directories = Array.from({ length: 15 }, (_, index) => ({
      key: `dir-${index}`, kind: "directory" as const, label: `dev-${index}`, path: `/dev/${index}`,
    }));
    const results = filterAtReferenceCandidates(directories, listInstanceReferences(health), "dev");
    expect(results.filter((entry) => entry.kind === "directory")).toHaveLength(10);
    expect(results.filter((entry) => entry.kind === "instance")).toHaveLength(2);
  });

  it("preserves encoded IDs and escaped labels through a canonical draft restore", () => {
    const path = buildInstanceReferenceUrl("machine/profile (dev)");
    const label = "Studio [lab] \\ dev";
    const token = createComposerAtReferenceToken({ kind: "instance", label, path }, 4);
    const text = serializeDraftWithSkillTokens("Use  please", [token]);
    const restored = hydrateComposerDraft(text, [], undefined, undefined);
    expect(parseInstanceReferenceUrl(path)).toBe("machine/profile (dev)");
    expect(restored.draft).toBe("Use  please");
    expect(restored.skillTokens[0]).toMatchObject({ kind: "instance", name: label, path, index: 4 });
    expect(serializeDraftWithSkillTokens(restored.draft, restored.skillTokens)).toBe(text);
    expect(text).toContain(buildInstanceReferenceMarkdown({ label, path }));
  });

  it("keeps reference examples in code literal", () => {
    const link = "[@Studio / dev](pwragent://instance/studio-dev)";
    for (const draft of [`\`${link}\``, `\`\`\`\n${link}\n\`\`\``]) {
      expect(hydrateComposerDraft(draft, [], undefined, undefined)).toEqual({ draft, skillTokens: [] });
    }
  });

  it.each(["pwragent://instance/", "pwragent://instance/%ZZ", "pwragent://instance/id/extra", "https://instance/id"])("rejects malformed or unrelated URLs: %s", (url) => {
    expect(parseInstanceReferenceUrl(url)).toBeUndefined();
  });
});
