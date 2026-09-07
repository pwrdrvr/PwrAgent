import type { DesktopApi } from "../desktop-api";
import { expect, it, vi } from "vitest";
import type { NavigationSelectedDetailResponse, NavigationThreadSummary } from "@pwragent/shared";
import { readNavigationActionDetail, readNavigationActionThread } from "../navigation-action-authority";

const row: NavigationThreadSummary = { id: "same", source: "codex", title: "Row", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true }, model: "stale-model" };

it("waits for owner authority and returns the owner configuration instead of row settings", async () => {
  let resolve!: (value: NavigationSelectedDetailResponse) => void;
  const getNavigationSelectedDetail = vi.fn(() => new Promise<NavigationSelectedDetailResponse>((done) => { resolve = done; }));
  let ready = false;
  const read = readNavigationActionThread({ api: { getNavigationSelectedDetail }, thread: row }).then((thread) => { ready = true; return thread; });
  await Promise.resolve();
  expect(ready).toBe(false);
  resolve({ protocol: 2, ref: { backend: "codex", threadId: "same" }, revision: "owner", readiness: "ready", identity: "present", thread: { ...row, model: "owner-model" } });
  expect((await read).model).toBe("owner-model");
});

it.each(["denied", "unresolved", "deleted", "archived"] as const)("rejects %s identity without using row authority", async (identity) => {
  await expect(readNavigationActionThread({ thread: row, api: { getNavigationSelectedDetail: async () => ({
    protocol: 2, ref: { backend: "codex", threadId: "same" }, revision: "owner", readiness: "ready", identity,
  }) } })).rejects.toThrow(identity);
});

it("routes the explicit owner and never falls through to a same-id local thread", async () => {
  const target = { scope: "remote" as const, instanceId: "peer" };
  const getNavigationSelectedDetail = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({ protocol: 2 as const, ref: request.ref, revision: "owner", readiness: "ready" as const, identity: "present" as const, thread: row }));
  const thread = await readNavigationActionThread({ thread: row, target, api: { getNavigationSelectedDetail } });
  expect(getNavigationSelectedDetail).toHaveBeenCalledWith({ protocol: 2, ref: { backend: "codex", threadId: "same", ownerInstanceId: "peer" }, federationTarget: target });
  expect(thread.federation?.ref.target).toEqual(target);
  await expect(readNavigationActionThread({ thread: row, target, api: { getNavigationSelectedDetail: async () => ({
    protocol: 2, ref: { backend: "codex", threadId: "same" }, revision: "wrong-owner", readiness: "ready", identity: "present", thread: row,
  }) } })).rejects.toThrow("requested owner");
});

it("rejects a delayed authority response after the requesting window closes", async () => {
  const controller = new AbortController();
  let resolve!: (value: NavigationSelectedDetailResponse) => void;
  const read = readNavigationActionThread({ thread: row, signal: controller.signal, api: {
    getNavigationSelectedDetail: () => new Promise<NavigationSelectedDetailResponse>((done) => { resolve = done; }),
  } });
  controller.abort();
  resolve({ protocol: 2, ref: { backend: "codex", threadId: "same" }, revision: "owner", readiness: "ready", identity: "present", thread: row });
  await expect(read).rejects.toMatchObject({ name: "AbortError" });
});

it("requires explicit owner workspace configuration for workspace actions", async () => {
  const read = vi.fn<NonNullable<DesktopApi["getNavigationSelectedDetail"]>>(async (request) => ({
    protocol: 2, ref: request.ref, revision: "old-peer", readiness: "ready", identity: "present", thread: row,
  }));
  await expect(readNavigationActionDetail({ thread: row, api: { getNavigationSelectedDetail: read }, includeWorkspaceConfiguration: true }))
    .rejects.toThrow("Upgrade the owning instance");
  expect(read).toHaveBeenCalledWith(expect.objectContaining({ includeWorkspaceConfiguration: true, probeWorkingStates: true }));
});
