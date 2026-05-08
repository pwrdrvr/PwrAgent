import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectPicker } from "../ProjectPicker";

afterEach(() => {
  cleanup();
});

const dirA: NavigationDirectorySummary = {
  key: "directory:/Users/me/code/PwrAgent",
  kind: "directory",
  label: "PwrAgent",
  path: "/Users/me/code/PwrAgent",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 1_000,
};

const dirB: NavigationDirectorySummary = {
  key: "directory:/Users/me/code/PwrSnap",
  kind: "directory",
  label: "PwrSnap",
  path: "/Users/me/code/PwrSnap",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 2_000,
};

const workspace: NavigationDirectorySummary = {
  key: "workspace:scratch",
  kind: "workspace",
  label: "Workspaces",
  path: "/Users/me/.pwragent/projects",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 500,
};

const unlinked: NavigationDirectorySummary = {
  key: "unlinked",
  kind: "unlinked",
  label: "No linked directory",
  threadKeys: [],
  needsAttentionCount: 0,
};

describe("ProjectPicker", () => {
  it("reads 'No selected project' with a dashed trigger when no value is set", () => {
    render(
      <ProjectPicker
        directories={[dirA]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    const trigger = screen.getByRole("button", { name: /choose a project/i });
    expect(trigger).toHaveTextContent("No selected project");
    expect(trigger.className).toContain("is-empty");
  });

  it("shows the current directory's label when a value is set", () => {
    render(
      <ProjectPicker
        value={dirA}
        directories={[dirA]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: /project: pwragent/i }),
    ).toHaveTextContent("PwrAgent");
  });

  it("opens a popover with tracked directories sorted by latestUpdatedAt desc", () => {
    render(
      <ProjectPicker
        directories={[dirA, dirB, workspace]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));

    const list = screen.getByRole("listbox", { name: /tracked directories/i });
    const rows = within(list).getAllByRole("option");
    // Workspace + dirB (most recent) + dirA. Workspace IS pickable
    // (kind "workspace") so it surfaces in the picker — only "unlinked"
    // is filtered out.
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("PwrSnap");
    expect(rows[1]).toHaveTextContent("PwrAgent");
    expect(rows[2]).toHaveTextContent("Workspaces");
  });

  it("filters out the 'unlinked' pseudo-directory", () => {
    render(
      <ProjectPicker
        directories={[dirA, unlinked]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    const list = screen.getByRole("listbox", { name: /tracked directories/i });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("PwrAgent");
  });

  it("filters by query against label or path", () => {
    render(
      <ProjectPicker
        directories={[dirA, dirB]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    const search = screen.getByPlaceholderText("Search directories");
    fireEvent.change(search, { target: { value: "snap" } });

    const list = screen.getByRole("listbox", { name: /tracked directories/i });
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("PwrSnap");
  });

  it("invokes onSelect when an existing directory is clicked", () => {
    const onSelect = vi.fn();
    render(
      <ProjectPicker
        directories={[dirA]}
        onSelect={onSelect}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    fireEvent.click(screen.getByRole("option", { name: /pwragent/i }));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith(dirA);
  });

  it("invokes onPickFromDisk when 'Add directory…' is clicked", () => {
    const onPickFromDisk = vi.fn();
    render(
      <ProjectPicker
        directories={[]}
        onSelect={() => undefined}
        onPickFromDisk={onPickFromDisk}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    fireEvent.click(screen.getByRole("button", { name: /add directory/i }));

    expect(onPickFromDisk).toHaveBeenCalledOnce();
  });

  it("disables the Add directory… row while picking is in flight", () => {
    render(
      <ProjectPicker
        directories={[]}
        picking
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    expect(screen.getByRole("button", { name: /picking/i })).toBeDisabled();
  });

  it("renders the inline pickError as an alert", () => {
    render(
      <ProjectPicker
        directories={[]}
        pickError="That folder isn't a git repository."
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      /isn't a git repository/i,
    );
  });

  it("shows an empty-state message when no directories match", () => {
    render(
      <ProjectPicker
        directories={[]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    expect(screen.getByText(/no tracked directories yet/i)).toBeInTheDocument();
  });

  it("closes the popover when Escape is pressed", () => {
    render(
      <ProjectPicker
        directories={[dirA]}
        onSelect={() => undefined}
        onPickFromDisk={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /choose a project/i }));
    expect(
      screen.getByRole("listbox", { name: /tracked directories/i }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("listbox", { name: /tracked directories/i }),
    ).not.toBeInTheDocument();
  });
});
