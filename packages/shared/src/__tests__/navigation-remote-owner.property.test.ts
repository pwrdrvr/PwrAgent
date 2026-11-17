import fc from "fast-check";
import { expect, it } from "vitest";
import type { NavigationQueryPage, NavigationRemoteOwner } from "../contracts/navigation";
import {
  expandNavigationRemoteOwner,
  navigationQueryPageBudgetBytes,
  navigationRemoteOwnerBytes,
} from "../navigation-remote-owner";

const OWNER = "pwr_owner";
/** UTF-8 length counted by hand, so the module's encoder is not its own oracle. */
function bytes(value: unknown): number {
  const text = JSON.stringify(value);
  let total = text.length;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) continue;
    const next = text.charCodeAt(index + 1);
    if (unit < 0x800) {
      total += 1;
    } else if (unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      // A surrogate pair is two units and four bytes.
      total += 2;
      index += 1;
    } else {
      // Three bytes, including the replacement character a lone surrogate becomes.
      total += 2;
    }
  }
  return total;
}

// Any UTF-16 units, so titles include lone surrogates and astral pairs.
const text = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 40 })
  .map((units) => String.fromCharCode(...units));

/**
 * A page as an owner sends it. An owner names another instance on rows and
 * parents it holds for that instance, and never names itself.
 */
const ownerPage = fc.record({
  entries: fc.array(fc.record({
    id: fc.uuid(),
    title: text,
    foreignOwner: fc.boolean(),
    parent: fc.constantFrom("none", "own", "foreign"),
  }), { maxLength: 30 }),
  directories: fc.array(fc.record({
    key: fc.uuid(),
    label: text,
    directoryThreadsCollapsed: fc.constantFrom(undefined, true, false),
  }), { maxLength: 12 }),
  selected: fc.boolean(),
}).map(({ entries, directories, selected }): NavigationQueryPage => ({
  protocol: 2, queryKey: "q", generation: "g", ownerEpoch: "e", countsRevision: "r",
  coverage: { state: "complete" }, counts: { total: entries.length, active: 0, unread: 0, review: 0 }, complete: true,
  entries: entries.map((entry, index) => ({
    orderKey: String(index),
    row: {
      id: entry.id, source: "codex", title: entry.title,
      ref: { backend: "codex", threadId: entry.id, ...(entry.foreignOwner ? { ownerInstanceId: "pwr_other" } : {}) },
      ...(entry.foreignOwner ? { federation: {
        instanceLabel: "Other", ref: { backend: "codex", threadId: entry.id, target: { scope: "remote", instanceId: "pwr_other" } },
      } } : {}),
    },
    placement: entry.parent === "none" ? { kind: "root" } : { kind: "child", parent: {
      backend: "codex", threadId: "parent", ...(entry.parent === "foreign" ? { ownerInstanceId: "pwr_other" } : {}),
    } },
  })),
  directories: directories.map(({ directoryThreadsCollapsed, ...directory }) => ({
    ...directory, ...(directoryThreadsCollapsed === undefined ? {} : { directoryThreadsCollapsed }),
  })),
  ...(selected && directories[0] ? { selectionDirectory: { key: directories[0].key, label: directories[0].label } } : {}),
}) as unknown as NavigationQueryPage);

/** A viewer's block for that page: its facts, and disclosure for some of the page's directories. */
const viewed = ownerPage.chain((page) => fc.record({
  capabilities: fc.array(fc.constantFrom("thread_navigation", "turn_control", "remote_pty"), { maxLength: 3 }),
  peerStatus: fc.constantFrom(undefined, "connected", "disconnected"),
  disclosed: fc.subarray(page.directories ?? []),
  collapsed: fc.boolean(),
}).map(({ capabilities, peerStatus, disclosed, collapsed }) => ({
  page,
  owner: {
    instanceId: OWNER, instanceLabel: "Owner / default", capabilities, peerStatus,
    ...(disclosed.length ? { directoryThreadsCollapsed: Object.fromEntries(disclosed.map(({ key }) => [key, collapsed])) } : {}),
  } as NavigationRemoteOwner,
})));

it("counts a page this instance owns as its whole serialized size", () => {
  fc.assert(fc.property(ownerPage, (page) => {
    expect(navigationQueryPageBudgetBytes(page)).toBe(bytes(page));
    expect(navigationRemoteOwnerBytes(page)).toBe(0);
    expect(expandNavigationRemoteOwner(page)).toBe(page);
  }));
});

it("charges a viewer what the page cost its owner, before and after rows are filled in", () => {
  fc.assert(fc.property(viewed, ({ page, owner }) => {
    const sent = { ...page, remoteOwner: owner };
    // Main retains and sends this form. It never costs more than the owner
    // measured, and less only by the disclosure values the viewer replaces.
    const charged = navigationQueryPageBudgetBytes(sent);
    const replaced = [...(page.directories ?? []), ...(page.selectionDirectory ? [page.selectionDirectory] : [])]
      .filter(({ key }) => Object.hasOwn(owner.directoryThreadsCollapsed ?? {}, key))
      .reduce((sum, { directoryThreadsCollapsed }) => sum + (directoryThreadsCollapsed === undefined
        ? 0 : `,"directoryThreadsCollapsed":${directoryThreadsCollapsed}`.length), 0);
    expect(charged).toBe(bytes(page) - replaced);
    // A window holds this form. Filling rows in changes nothing it is charged.
    const filled = expandNavigationRemoteOwner(sent);
    expect(navigationQueryPageBudgetBytes(filled)).toBe(charged);
    expect(navigationRemoteOwnerBytes(filled)).toBe(bytes(owner));
  }));
});

it("fills every row the owner did not assign elsewhere, and leaves the others alone", () => {
  fc.assert(fc.property(viewed, ({ page, owner }) => {
    const filled = expandNavigationRemoteOwner({ ...page, remoteOwner: owner });
    expect(expandNavigationRemoteOwner(filled)).toEqual(filled);
    filled.entries.forEach((entry, index) => {
      const sent = page.entries[index]!;
      if (sent.row.ref.ownerInstanceId) {
        expect(entry.row).toBe(sent.row);
      } else {
        expect(entry.row.ref.ownerInstanceId).toBe(OWNER);
        expect(entry.row.federation).toMatchObject({ instanceLabel: owner.instanceLabel,
          ref: { backend: "codex", threadId: sent.row.id, target: { scope: "remote", instanceId: OWNER } } });
        // One array for the page, not a copy per row.
        expect(entry.row.federation?.capabilities).toBe(owner.capabilities);
        expect(entry.row.federation?.peerStatus).toBe(owner.peerStatus);
      }
      if (sent.placement.kind === "child" && entry.placement.kind === "child") {
        expect(entry.placement.parent.ownerInstanceId).toBe(sent.placement.parent.ownerInstanceId ?? OWNER);
      }
    });
    for (const [index, directory] of (filled.directories ?? []).entries()) {
      const sent = page.directories![index]!;
      const viewer = owner.directoryThreadsCollapsed;
      expect(directory.directoryThreadsCollapsed)
        .toBe(viewer && Object.hasOwn(viewer, sent.key) ? viewer[sent.key] : sent.directoryThreadsCollapsed);
    }
  }));
});
