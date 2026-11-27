import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { LinkedDirectorySummary } from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { copyText } from "../../../../lib/copy-text";
import { cssWithOnlyProperties } from "../../../../styles/__tests__/css-property-cascade";
import { DetailsFoldersSection } from "../DetailsFoldersSection";

vi.mock("../../../../lib/copy-text", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../lib/copy-text")>(),
  copyText: vi.fn(async () => undefined),
}));

const style = document.createElement("style");
beforeAll(() => {
  const css = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../styles/app.css"), "utf8");
  style.textContent = cssWithOnlyProperties(css, ["display", "visibility"]);
  document.head.append(style);
});
afterAll(() => style.remove());
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-density");
  vi.clearAllMocks();
});

function threadFor(directory: LinkedDirectorySummary, id = directory.id): NavigationThreadSummary {
  return {
    id,
    title: "Inspect checkout",
    titleSource: "explicit",
    source: "codex",
    projectKey: directory.worktreePath ?? directory.path,
    linkedDirectories: [directory],
    inbox: { inInbox: false },
  };
}

/** Opens a folder's ⋯ menu and returns it. */
function openFolderMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.click(trigger);
  return screen.getByRole("menu");
}

function copyPathFrom(trigger: HTMLElement): void {
  fireEvent.click(within(openFolderMenu(trigger)).getByRole("menuitem", { name: /^Copy path/ }));
}

describe("linked project checkout identity", () => {
  it("uses the checkout path for the project heading's tooltip and copy action", () => {
    const checkout = "/Users/fixture/.codex/worktrees/checkout-one/Project";
    const directory: LinkedDirectorySummary = {
      id: "checkout-one", kind: "worktree", label: "Project",
      path: "/Users/fixture/projects/Project", worktreePath: checkout,
    };
    const showTooltip = vi.fn();
    const panel = render(<DetailsFoldersSection thread={threadFor(directory)}
      showTooltip={showTooltip} hideTooltip={() => undefined} />);

    fireEvent.mouseEnter(panel.getByLabelText("Path for Project"));
    expect(showTooltip.mock.lastCall?.[1]).toBe(checkout);
    copyPathFrom(panel.getByRole("button", { name: "Folder actions for Project" }));
    expect(copyText).toHaveBeenLastCalledWith(checkout);
  });

  for (const density of [undefined, "compact", "minimal"]) {
    it(`shows the checkout separately from its home repository in ${density ?? "Mission Control"}`, () => {
      if (density) document.documentElement.dataset.density = density;
      const checkout = "/Users/fixture/.codex/worktrees/checkout-one/Project";
      const directory: LinkedDirectorySummary = {
        id: "checkout-one", kind: "worktree", label: "Project",
        path: "/Users/fixture/projects/Project", worktreePath: checkout,
      };
      const panel = render(<DetailsFoldersSection thread={threadFor(directory)}
        showTooltip={() => undefined} hideTooltip={() => undefined} />);

      // The path must be readable without opening a tooltip or a menu.
      expect(panel.queryByText(checkout)).toBeVisible();
    });
  }

  it("keeps visible, tooltip and copied checkout paths in agreement through thread and density changes", () => {
    const segment = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,12}$/);
    fc.assert(fc.property(
      segment,
      fc.boolean(),
      fc.constantFrom("local", "worktree", "worktree-fallback"),
      fc.array(fc.record({
        sibling: fc.integer({ min: 0, max: 1 }),
        density: fc.constantFrom("mission-control", "compact", "minimal"),
      }), { minLength: 2, maxLength: 6 }),
      (project, windows, kind, steps) => {
        const root = windows ? "C:\\Users\\fixture" : "/Users/fixture";
        const sep = windows ? "\\" : "/";
        const home = [root, "projects", project].join(sep);
        const checkouts = [0, 1].map((sibling) =>
          [root, ".codex", "worktrees", `checkout-${sibling}`, project].join(sep));
        const directories = checkouts.map((checkout, sibling): LinkedDirectorySummary => ({
          id: `directory-${sibling}`,
          kind: kind === "local" ? "local" : "worktree",
          label: project,
          path: kind === "worktree" ? home : checkout,
          worktreePath: kind === "worktree" ? checkout : undefined,
          gitBranch: "shared-branch",
        }));
        const showTooltip = vi.fn();
        const view = (sibling: number) => <DetailsFoldersSection
          thread={threadFor(directories[sibling]!, `thread-${sibling}`)}
          showTooltip={showTooltip} hideTooltip={() => undefined} />;
        const panel = render(view(0));
        try {
          for (const { sibling, density } of [
            { sibling: 0, density: "mission-control" },
            { sibling: 1, density: "mission-control" },
            ...steps,
          ]) {
            if (density === "mission-control") document.documentElement.removeAttribute("data-density");
            else document.documentElement.dataset.density = density;
            panel.rerender(view(sibling));
            const expected = checkouts[sibling]!;
            expect(panel.queryByText(expected)).toBeVisible();
            expect(panel.queryByText(checkouts[1 - sibling]!)).not.toBeInTheDocument();
            fireEvent.mouseEnter(panel.getByLabelText(`Path for ${project}`));
            expect(showTooltip.mock.lastCall?.[1]).toBe(expected);
            copyPathFrom(panel.getByRole("button", { name: `Folder actions for ${project}` }));
            expect(copyText).toHaveBeenLastCalledWith(expected);
          }
        } finally {
          panel.unmount();
        }
      },
    ), { numRuns: 8 });
  });

  it("offers Detach on the secondary worktree regardless of the display order", () => {
    fc.assert(fc.property(
      fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/),
      fc.boolean(),
      fc.boolean(),
      (name, windows, reverse) => {
        const root = windows ? "C:\\fixture\\worktrees\\" : "/fixture/worktrees/";
        const primary: LinkedDirectorySummary = {
          id: "primary", kind: "worktree", label: "Project", path: "/fixture/repos/Project",
          worktreePath: `${root}${name}`,
        };
        const secondary: LinkedDirectorySummary = {
          ...primary, id: "secondary", worktreePath: `${root}${name}-sibling`,
        };
        const panel = render(<DetailsFoldersSection
          desktopApi={{ detachDirectoryFromThread: vi.fn() }}
          thread={{
            ...threadFor(primary),
            projectKey: `${primary.worktreePath?.replace(/\\/g, "/")}/src`,
            linkedDirectories: reverse ? [secondary, primary] : [primary, secondary],
          }}
          showTooltip={() => undefined}
          hideTooltip={() => undefined}
        />);
        try {
          const attached = panel.getByRole("list", { name: "Attached folders" });
          const primaryList = panel.getByRole("list", { name: "Primary folder" });
          // The attached row is the sibling, whichever order the thread lists them in.
          expect(within(attached).getByText(secondary.worktreePath!)).toBeVisible();
          const attachedMenu = openFolderMenu(within(attached).getByRole("button", { name: "Folder actions for Project" }));
          expect(within(attachedMenu).getByRole("menuitem", { name: "Detach" })).toBeVisible();
          fireEvent.keyDown(attachedMenu, { key: "Escape" });
          const primaryMenu = openFolderMenu(within(primaryList).getByRole("button", { name: "Folder actions for Project" }));
          expect(within(primaryMenu).queryByRole("menuitem", { name: "Detach" })).toBeNull();
          fireEvent.keyDown(primaryMenu, { key: "Escape" });
        } finally {
          panel.unmount();
        }
      },
    ), { numRuns: 8 });
  });
});
