// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { navigationQueryFixture } from "../../../test/navigation-query-fixture";
import { ProjectSearchInput, projectMentionAtCursor } from "../ProjectSearchInput";

function setup() {
  const getNavigationQueryPage = vi.fn<NonNullable<DesktopApi["getNavigationQueryPage"]>>(async (request) =>
    navigationQueryFixture(request, { directories: [
      { key: "disk", kind: "directory", label: "diskhound", path: "/projects/diskhound" },
      { key: "tree", kind: "directory", label: "disktree", path: "/projects/disktree" },
      { key: "space", kind: "directory", label: "My Project", path: "/projects/My Project" },
    ] }),
  );
  const releaseNavigationQuery = vi.fn(async () => undefined);
  const submit = vi.fn((event) => event.preventDefault());
  const close = vi.fn();
  function Harness() {
    const [value, setValue] = useState("");
    return <form onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape") close(); }}>
      <ProjectSearchInput value={value} onChange={setValue} desktopApi={{ getNavigationQueryPage, releaseNavigationQuery }} />
      <button type="submit">Search</button>
    </form>;
  }
  render(<Harness />);
  return { input: screen.getByRole("combobox"), getNavigationQueryPage, releaseNavigationQuery, submit, close };
}

describe("project search picker", () => {
  it("opens on @, filters using the owner query, and selects without submitting", async () => {
    const { input, getNavigationQueryPage, submit } = setup();
    fireEvent.change(input, { target: { value: '"ad hoc" @dis' } });
    expect(await screen.findByRole("option", { name: /diskhound/ })).toBeInTheDocument();
    expect(getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 10, query: { kind: "directory-index", filter: "dis" },
    }), expect.any(String));
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue('"ad hoc" @disktree ');
    expect(input).toHaveFocus();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(submit).not.toHaveBeenCalled();
  });

  it("inserts quoted names using in:@ and keeps earlier mentions", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: '@diskhound build in:@My' } });
    fireEvent.click(await screen.findByRole("option", { name: /My Project/ }));
    expect(input).toHaveValue('@diskhound build in:@"My Project" ');
  });

  it("Escape dismisses only the picker and releases its query", async () => {
    const { input, close, releaseNavigationQuery } = setup();
    fireEvent.change(input, { target: { value: "@" } });
    await screen.findByRole("option", { name: /diskhound/ });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(releaseNavigationQuery).toHaveBeenCalled());
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not trigger inside quoted text or email addresses", () => {
    for (const value of ['"@disk"', '"text @disk', "a@disk"]) {
      expect(projectMentionAtCursor(value, value.length)).toBeUndefined();
    }
  });

  it("replaces the full mention when editing in the middle of a query", () => {
    expect(projectMentionAtCursor('build @diskhound later', 9)).toEqual({
      start: 6, end: 16, prefix: "@", query: "di",
    });
  });

  it("preserves trailing query text and places the caret after a replacement", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "build @diskhound later" } });
    (input as HTMLInputElement).setSelectionRange(9, 9);
    fireEvent.select(input);
    fireEvent.click(await screen.findByRole("option", { name: /disktree/ }));
    expect(input).toHaveValue("build @disktree later");
    expect((input as HTMLInputElement).selectionStart).toBe(16);
  });

  it("selects with Tab and shows an empty state for unmatched projects", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "@diskh" } });
    await screen.findByRole("option", { name: /diskhound/ });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("@diskhound ");
    fireEvent.change(input, { target: { value: "@missing" } });
    expect(await screen.findByText("No matching projects")).toBeInTheDocument();
  });
});
