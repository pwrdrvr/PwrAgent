import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import fc from "fast-check";
import type { FederationTarget, NavigationDirectorySummary } from "@pwragent/shared";
import { navigationQueryFixture } from "../../test/navigation-query-fixture";
import type { DesktopApi } from "../desktop-api";
import { useThreadNavigation } from "../useThreadNavigation";

afterEach(() => {
  delete (window as typeof window & { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
});

type Command = { kind: "pin" | "unpin" | "up" | "down"; index: number };
const projects = ["git", "PwrAgent", "PwrGit"].map((label): NavigationDirectorySummary => ({
  key: `directory:/fixture/${label}`, kind: "directory", label, path: `/fixture/${label}`,
  threadKeys: [], needsAttentionCount: 0,
}));

async function exercisePins(remote: boolean, commands: Command[]) {
  const target = { scope: "remote" as const, instanceId: "m2-max" };
  if (remote) Object.assign(window, { __pwragentFederationTarget: target });
  // Same paths on both machines: the window's owner, never the key, decides
  // where a write belongs. The other machine must keep its original order.
  const initial = [projects[1]!.key, projects[2]!.key];
  const pins = { local: [...initial], remote: [...initial] };
  const selectedOwner = remote ? "remote" : "local";
  const expected = [...initial];
  const ownerFor = (request: { federationTarget?: FederationTarget }) =>
    request.federationTarget?.scope === "remote" ? "remote" : "local";
  const ranks = (keys: string[]) => Object.fromEntries(keys.map((key, index) => [key, String((index + 1) * 1024)]));
  const api: DesktopApi = {
    getNavigationQueryPage: async (request) => {
      const ownerRanks = ranks(pins[ownerFor(request)]);
      return navigationQueryFixture(request, { directories: projects.map((project) => ({
        ...project, pinnedRank: ownerRanks[project.key],
      })) });
    },
    setDirectoryPin: async (request) => {
      const owner = ownerFor(request);
      if (!request.pinned) pins[owner] = pins[owner].filter((key) => key !== request.directoryKey);
      else if (!pins[owner].includes(request.directoryKey)) pins[owner].push(request.directoryKey);
      return { directoryKey: request.directoryKey, pinnedRank: ranks(pins[owner])[request.directoryKey] };
    },
    reorderDirectoryPins: async (request) => {
      const keys = pins[ownerFor(request)];
      const move = request.move!;
      const from = keys.indexOf(move.key);
      const to = from + (move.direction === "up" ? -1 : 1);
      if (from >= 0 && to >= 0 && to < keys.length) {
        keys.splice(from, 1);
        keys.splice(to, 0, move.key);
      }
      return { pinnedRanks: ranks(keys) };
    },
    releaseNavigationQuery: async () => undefined,
    onAgentEvent: () => () => undefined,
  };
  const hook = renderHook(() => useThreadNavigation(api));
  try {
    await act(async () => {});
    expect(hook.result.current.directories).toHaveLength(projects.length);
    for (const command of commands) {
      const project = hook.result.current.directories.find((directory) => directory.key === projects[command.index]!.key)!;
      const from = expected.indexOf(project.key);
      if (command.kind === "pin" || command.kind === "unpin") {
        if (command.kind === "unpin" && from >= 0) expected.splice(from, 1);
        if (command.kind === "pin" && from < 0) expected.push(project.key);
        await act(() => hook.result.current.setDirectoryPin(project, command.kind === "pin"));
      } else {
        const direction = command.kind;
        const to = from + (command.kind === "up" ? -1 : 1);
        if (from < 0) continue;
        if (to >= 0 && to < expected.length) {
          expected.splice(from, 1);
          expected.splice(to, 0, project.key);
        }
        await act(() => hook.result.current.reorderDirectoryPins([], { key: project.key, direction }));
      }
      await act(() => hook.result.current.refresh());
      // Oracle: a fresh owner read must agree with every accepted command,
      // and the viewer must not have changed the other machine's pins.
      expect(pins[selectedOwner]).toEqual(expected);
      expect(pins[remote ? "local" : "remote"]).toEqual(initial);
      expect(hook.result.current.directories.filter((directory) => directory.pinnedRank)
        .sort((left, right) => Number(left.pinnedRank) - Number(right.pinnedRank))
        .map((directory) => directory.key)).toEqual(expected);
    }
  } finally {
    hook.unmount();
    delete (window as typeof window & { __pwragentFederationTarget?: unknown }).__pwragentFederationTarget;
  }
}

it("keeps a remote project's pin after the next owner refresh", async () => {
  await exercisePins(true, [{ kind: "pin", index: 0 }]);
});

it("reorders the remote owner's existing project pins", async () => {
  await exercisePins(true, [{ kind: "up", index: 2 }]);
});

it("keeps project pin commands and refreshes consistent with the window's owner", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.array(fc.record({
    kind: fc.constantFrom<Command["kind"]>("pin", "unpin", "up", "down"),
    index: fc.integer({ min: 0, max: projects.length - 1 }),
  }), { minLength: 1, maxLength: 8 }), exercisePins), { numRuns: 25 });
});
