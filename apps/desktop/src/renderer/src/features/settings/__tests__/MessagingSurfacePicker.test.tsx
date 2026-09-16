import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingSurfacePicker } from "../MessagingSurfacePicker";

afterEach(cleanup);

const options = [
  { value: "channel-a", label: "Orchard", kind: "channel" as const, detail: "C_ORCHARD", seen: "Sep 16" },
  { value: "channel-b", label: "Meadow", kind: "channel" as const, detail: "C_MEADOW", seen: "Sep 15" },
  { value: "dm", label: "Alex and Sam", kind: "dm" as const, detail: "D_FRIENDS", seen: "Sep 14" },
  { value: "thread", label: "Harvest discussion", kind: "thread" as const },
  { value: "topic", label: "Garden topic", kind: "topic" as const, detail: "T_GARDEN", seen: "Sep 13" },
];

const CLOSED_LABEL = "Choose a messaging surface";

function setup(value = "", allowTopics = false) {
  const onChange = vi.fn();
  render(<MessagingSurfacePicker value={value} options={options} filterConversations allowTopics={allowTopics} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: value ? /^Surface: / : CLOSED_LABEL }));
  return onChange;
}

function labels() {
  return within(screen.getByRole("listbox")).queryAllByRole("option").map((option) => option.textContent);
}

function sections() {
  return within(screen.getByRole("listbox"))
    .queryAllByRole("group")
    .map((group) => group.getAttribute("aria-label"));
}

describe("MessagingSurfacePicker", () => {
  it("groups durable destinations by kind and never offers ephemeral threads", () => {
    setup();
    expect(sections()).toEqual(["Channels & groups", "Direct messages"]);
    expect(labels()).toEqual([
      "#OrchardC_ORCHARDSep 16",
      "#MeadowC_MEADOWSep 15",
      "@Alex and SamD_FRIENDSSep 14",
    ]);
    expect(screen.queryByRole("option", { name: /Harvest discussion/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Garden topic/ })).not.toBeInTheDocument();
  });

  it("gives named Telegram topics their own section when the platform allows them", () => {
    setup("", true);
    expect(sections()).toEqual(["Channels & groups", "Direct messages", "Telegram topics"]);
    expect(screen.getByRole("option", { name: /Garden topic/ })).toBeInTheDocument();
  });

  it("replaces the trigger while open so the field shows no stale placeholder", () => {
    setup();
    expect(screen.queryByRole("button", { name: CLOSED_LABEL })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.getByRole("button", { name: CLOSED_LABEL })).toBeInTheDocument();
  });

  it("names the chosen destination on the closed trigger", () => {
    setup("topic", true);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Surface: Garden topic" })).toBeInTheDocument();
    expect(screen.getByText("Garden topic")).toBeInTheDocument();
  });

  it("marks the chosen destination as selected", () => {
    setup("topic", true);
    expect(screen.getByRole("option", { name: /Garden topic/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Orchard/ })).toHaveAttribute("aria-selected", "false");
  });

  it("searches every candidate by name or ID and selects with the keyboard", () => {
    const onChange = setup();
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: " c_meadow " } });
    expect(labels()).toEqual(["#MeadowC_MEADOWSep 15"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("channel-b");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: CLOSED_LABEL })).toHaveFocus();
  });

  it("walks the cursor across section headings with the arrow keys", () => {
    const onChange = setup();
    const input = screen.getByRole("combobox");
    // Third press crosses from the channels section into direct messages.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-2$/));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("dm");
  });

  it("dismisses without changing the selection", () => {
    const onChange = setup();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: CLOSED_LABEL })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: CLOSED_LABEL }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps manual entry available after an empty search", () => {
    const onChange = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unknown" } });
    expect(screen.getByText("No matching surfaces.")).toBeInTheDocument();
    expect(screen.queryAllByRole("group")).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enter an ID manually..." }));
    expect(onChange).toHaveBeenCalledWith("manual");
  });

  it("keeps a saved thread route visible in its own editor", () => {
    // Threads stopped being selectable, but a route saved before that must
    // still show what it targets — and must not be marked as a channel.
    const onChange = vi.fn();
    render(
      <MessagingSurfacePicker
        value="thread"
        filterConversations
        onChange={onChange}
        options={[
          { value: "thread", label: "Harvest discussion", kind: "thread" as const, section: "configured" as const, detail: "T_HARVEST" },
          ...options.filter((option) => option.kind === "channel"),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Surface: Harvest discussion" }));
    expect(sections()).toEqual(["Current configuration", "Channels & groups"]);
    const saved = screen.getByRole("option", { name: /Harvest discussion/ });
    expect(saved).toHaveAttribute("aria-selected", "true");
    // Assert the glyph element itself: a row whose name or ID happened to
    // contain "#" would pass or fail a whole-text check for the wrong reason.
    expect(
      saved.querySelector(".messaging-surface-picker__glyph")?.textContent,
    ).toBe("▸");
  });

  it("keeps reporting a selection whose option has dropped out of the list", () => {
    // The routes provider reloads observed surfaces on every bindings change,
    // so a candidate can vanish mid-edit while the form still holds it. The
    // field must not answer "nothing chosen" for a surface Save would write.
    render(
      <MessagingSurfacePicker
        value="channel-a"
        options={options.filter((option) => option.value !== "channel-a")}
        filterConversations
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: CLOSED_LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Surface: / })).toBeInTheDocument();
  });

  it("names manual entry on the closed trigger", () => {
    render(<MessagingSurfacePicker value="manual" options={options} filterConversations onChange={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "Surface: Enter an ID manually..." }),
    ).toBeInTheDocument();
  });

  it("announces the empty state from outside the listbox", () => {
    setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unknown" } });
    // Inside the listbox assistive technology drops it; outside with no live
    // region nothing announces it. It needs both.
    const empty = screen.getByRole("status");
    expect(empty).toHaveTextContent("No matching surfaces.");
    expect(screen.getByRole("listbox")).not.toContainElement(empty);
  });

  it("drops the kind glyph for container scopes, which are not channels", () => {
    render(
      <MessagingSurfacePicker
        value=""
        filterConversations={false}
        onChange={vi.fn()}
        options={[{ value: "workspace", label: "Orchard Co", detail: "T012AB", seen: "Sep 16" }]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: CLOSED_LABEL }));
    expect(sections()).toEqual(["Recently seen"]);
    expect(labels()).toEqual(["Orchard CoT012ABSep 16"]);
  });
});
