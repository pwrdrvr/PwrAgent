import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagingSurfacePicker } from "../MessagingSurfacePicker";

afterEach(cleanup);

const options = [
  { value: "channel-a", label: "Orchard", kind: "channel" as const, detail: "ID C_ORCHARD" },
  { value: "channel-b", label: "Meadow", kind: "channel" as const, detail: "ID C_MEADOW" },
  { value: "dm", label: "Alex and Sam", kind: "dm" as const, detail: "ID D_FRIENDS" },
  { value: "thread", label: "Harvest discussion", kind: "thread" as const },
  { value: "topic", label: "Garden topic", kind: "topic" as const },
];

function setup(value = "", allowTopics = false) {
  const onChange = vi.fn();
  render(<MessagingSurfacePicker value={value} options={options} filterConversations allowTopics={allowTopics} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Messaging surface" }));
  return onChange;
}

function labels() {
  return within(screen.getByRole("listbox")).queryAllByRole("option").map((option) => option.textContent);
}

describe("MessagingSurfacePicker", () => {
  it("starts with channels and DMs and never offers ephemeral threads", () => {
    setup();
    expect(labels()).toEqual(["OrchardID C_ORCHARD", "MeadowID C_MEADOW", "Alex and SamID D_FRIENDS"]);
    fireEvent.click(screen.getByRole("button", { name: "Direct messages" }));
    expect(labels()).toEqual(["Alex and SamID D_FRIENDS"]);
    fireEvent.click(screen.getByRole("button", { name: "Channels / groups" }));
    expect(labels()).toEqual(["OrchardID C_ORCHARD", "MeadowID C_MEADOW"]);
    expect(screen.queryByRole("button", { name: "Telegram topics" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Harvest discussion/ })).not.toBeInTheDocument();
  });

  it("searches every candidate by name or ID and selects with the keyboard", () => {
    const onChange = setup();
    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: " c_meadow " } });
    expect(labels()).toEqual(["MeadowID C_MEADOW"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("channel-b");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Messaging surface")).toHaveFocus();
  });

  it("moves the active result with arrows and dismisses without changing selection", () => {
    const onChange = setup();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("channel-b");
    onChange.mockClear();
    fireEvent.click(screen.getByLabelText("Messaging surface"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Messaging surface")).toHaveFocus();
    fireEvent.click(screen.getByLabelText("Messaging surface"));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps manual entry available after an empty search", () => {
    const onChange = setup();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unknown" } });
    expect(screen.getByText("No matching surfaces.")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Enter an ID manually..." }));
    expect(onChange).toHaveBeenCalledWith("manual");
  });

  it("opens a selected Telegram topic in the topic filter", () => {
    setup("topic", true);
    expect(screen.getByRole("button", { name: "Telegram topics" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: /Garden topic/ })).toHaveAttribute("aria-selected", "true");
  });
});
