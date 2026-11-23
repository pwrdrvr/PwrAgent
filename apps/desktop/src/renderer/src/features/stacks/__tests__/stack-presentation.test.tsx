import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { compactStackMembership, type StackSummary } from "@pwragent/shared/stacks/stack-status";
import { StackPositionChips, visibleStackTray } from "../stack-presentation";
import { StarMapStackEdges } from "../StarMapStackEdges";

it("renders the same chip, stack tray and Star Map edge from compact rows and older full rows", () => {
  const stack: StackSummary = {
    key: "example-stack", name: "Example stack", repository: "github.com:fixture/project", trunk: "main", inferred: true,
    layers: [
      { branch: "lower", parent: "main", health: "in_sync", role: "layer", thread: { key: "codex:lower", title: "Lower" },
        pullRequest: { number: 1, lifecycleState: "merged" } },
      { branch: "upper", parent: "lower", health: "needs_restack", role: "layer", thread: { key: "codex:upper", title: "Upper" } },
    ],
  };
  const thread = (id: string): NavigationThreadSummary => ({
    source: "codex", id, title: id, titleSource: "derived", linkedDirectories: [], inbox: { inInbox: false },
  });
  const oldRows = [
    { ...thread("lower"), stacks: [{ stack, position: 1 }] },
    { ...thread("upper"), stacks: [{ stack, position: 2 }] },
  ];
  const compactRows = [
    { ...thread("lower"), stackMemberships: [compactStackMembership(stack, 1)!] },
    { ...thread("upper"), stackMemberships: [compactStackMembership(stack, 2)!] },
  ];
  const rects = new Map([
    ["fixture::codex:lower", { x: 10, y: 10, width: 100, height: 100 }],
    ["fixture::codex:upper", { x: 150, y: 30, width: 100, height: 100 }],
  ]);
  const presentation = (rows: NavigationThreadSummary[]) => <>
    <StackPositionChips thread={rows[1]!} />
    <StarMapStackEdges threads={rows} rects={rects} instanceId="fixture" />
  </>;
  const view = render(presentation(oldRows));
  const before = view.container.innerHTML;
  expect(visibleStackTray(oldRows[0]!, oldRows.slice(1))).toBe(stack.key);
  expect(before).toContain('data-state="merged"');
  expect(before).toContain("2/2");
  view.rerender(presentation(compactRows));
  expect(view.container.innerHTML).toBe(before);
  expect(visibleStackTray(compactRows[0]!, compactRows.slice(1))).toBe(stack.key);
});
