import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingSurfacePicker, placePanel } from "../MessagingSurfacePicker";

afterEach(cleanup);

const options = [
  { value: "channel-a", label: "Orchard", kind: "channel" as const, detail: "C_ORCHARD", seen: "Sep 16" },
  { value: "channel-b", label: "Meadow", kind: "channel" as const, detail: "C_MEADOW", seen: "Sep 15" },
  { value: "dm", label: "Alex and Sam", kind: "dm" as const, detail: "D_FRIENDS", seen: "Sep 14" },
  { value: "thread", label: "Harvest discussion", kind: "thread" as const },
  { value: "topic", label: "Garden topic", kind: "topic" as const, detail: "T_GARDEN", seen: "Sep 13" },
];

// The accessible name is always "<field>: <whatever the button shows>", so
// one regex finds the trigger in every state and the unset case is explicit.
const CLOSED_LABEL = "Surface: Choose a recently seen surface...";
const ANY_TRIGGER = /^Surface: /;

function setup(value = "", allowTopics = false) {
  const onChange = vi.fn();
  render(<MessagingSurfacePicker fieldLabel="Surface" value={value} options={options} filterConversations allowTopics={allowTopics} onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: ANY_TRIGGER }));
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

/** A trigger rect at the given position; only these four fields are read. */
function triggerRect(box: {
  top: number;
  bottom: number;
  left: number;
  width: number;
}): DOMRect {
  return box as unknown as DOMRect;
}

describe("placePanel", () => {
  const viewport = { width: 1440, height: 900 };

  beforeEach(() => {
    window.innerWidth = viewport.width;
    window.innerHeight = viewport.height;
  });

  it("caps the panel height instead of growing to fill the viewport", () => {
    // Without a ceiling a tall window turns twenty rows into a dropdown
    // covering most of the screen; the branch picker stops at 440.
    const placed = placePanel(triggerRect({ top: 100, bottom: 132, left: 40, width: 560 }));
    expect(placed.flipped).toBe(false);
    expect(placed.maxHeight).toBe(440);
  });

  it("keeps a narrow window's panel inside the viewport", () => {
    window.innerWidth = 320;
    const placed = placePanel(triggerRect({ top: 100, bottom: 132, left: 8, width: 300 }));
    // The minimum width cannot win over the viewport: `left` alone cannot
    // rescue a panel wider than the window.
    expect(placed.left + placed.width).toBeLessThanOrEqual(320);
    expect(placed.left).toBeGreaterThanOrEqual(0);
  });

  it("holds the panel on screen when the trigger scrolls out of its pane", () => {
    // `reposition` runs on every scroll, so an unclamped top would drag the
    // panel off-screen while it is still open and holding focus.
    // A flipped panel is pinned by its bottom edge and grows upward, so its
    // bounds are [top - maxHeight, top]; an unflipped one runs downward.
    const bounds = (placed: ReturnType<typeof placePanel>) =>
      placed.flipped
        ? [placed.top - placed.maxHeight, placed.top]
        : [placed.top, placed.top + placed.maxHeight];

    for (const rect of [
      triggerRect({ top: 2000, bottom: 2032, left: 40, width: 560 }),
      triggerRect({ top: -2000, bottom: -1968, left: 40, width: 560 }),
    ]) {
      const [top, bottom] = bounds(placePanel(rect));
      expect(top).toBeGreaterThanOrEqual(0);
      expect(bottom).toBeLessThanOrEqual(viewport.height);
    }
  });

  it("flips upward without growing past the top of the window", () => {
    const placed = placePanel(triggerRect({ top: 820, bottom: 852, left: 40, width: 560 }));
    expect(placed.flipped).toBe(true);
    // A flipped panel is pinned by its bottom edge, so its top is
    // `top - maxHeight`; that has to stay on screen.
    expect(placed.top - placed.maxHeight).toBeGreaterThanOrEqual(0);
  });
});

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

  it("opens as a popover outside the field, and the trigger toggles it", () => {
    const onChange = vi.fn();
    const { container } = render(
      <MessagingSurfacePicker fieldLabel="Surface" value="" options={options} filterConversations onChange={onChange} />,
    );
    const trigger = screen.getByRole("button", { name: CLOSED_LABEL });

    fireEvent.click(trigger);
    const panel = screen.getByRole("dialog", { name: "Surface" });
    // Portalled: the panel must not be a descendant of the field, or every
    // `overflow: hidden` ancestor between them would clip it.
    expect(container).not.toContainElement(panel);
    expect(document.body).toContainElement(panel);
    // And it was measured and placed against the trigger rather than laid out
    // in flow. (`position: fixed` itself comes from app.css, which jsdom does
    // not load, so the inline placement is what is observable here.)
    expect(panel.style.width).not.toBe("");
    expect(panel.style.maxHeight).not.toBe("");
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    // The trigger stays put and closes what it opened.
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("survives the focus move that opening it causes", () => {
    // The sequence a real click produces, which `fireEvent.click` alone does
    // not: the trigger takes focus, then the panel's search input pulls it
    // away via `autoFocus`. That fires a focus-out on the field whose
    // relatedTarget lives in the portal — not a DOM descendant of the field.
    // A close-on-focus-out check closed the panel in the frame it opened, so
    // it flashed and vanished, and no assertion that only clicked the trigger
    // could see it.
    render(
      <MessagingSurfacePicker fieldLabel="Surface" value="" options={options} filterConversations onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: CLOSED_LABEL });
    trigger.focus();
    fireEvent.click(trigger);

    const input = screen.getByRole("combobox");
    fireEvent.focusOut(trigger, { relatedTarget: input });
    fireEvent.blur(trigger, { relatedTarget: input });

    expect(screen.getByRole("dialog", { name: "Surface" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
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
        fieldLabel="Surface"
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
        fieldLabel="Surface"
        value="channel-a"
        options={options.filter((option) => option.value !== "channel-a")}
        filterConversations
        onChange={vi.fn()}
      />,
    );
    // No label survives for it, but the field must not answer "nothing chosen".
    expect(screen.queryByRole("button", { name: CLOSED_LABEL })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Surface: Selected (no longer listed)" }),
    ).toBeInTheDocument();
  });

  it("names manual entry on the closed trigger", () => {
    render(<MessagingSurfacePicker fieldLabel="Surface" value="manual" options={options} filterConversations onChange={vi.fn()} />);
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

  it("offers threads under their own heading when the caller allows them", () => {
    render(
      <MessagingSurfacePicker fieldLabel="Surface" value="" options={options} filterConversations allowTopics allowThreads onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: CLOSED_LABEL });
    trigger.focus();
    fireEvent.click(trigger);
    // Not filed under the topic heading: "Telegram topics" is false of a
    // Discord thread, and one shared bucket would merge the two kinds for a
    // caller that offers both.
    expect(sections()).toEqual(["Channels & groups", "Direct messages", "Telegram topics", "Threads"]);
    const thread = within(screen.getByRole("group", { name: "Threads" })).getByRole("option");
    expect(thread).toHaveTextContent("Harvest discussion");
    expect(
      thread.querySelector(".messaging-surface-picker__glyph")?.textContent,
    ).toBe("▸");
  });

  it("names the search row from searchLabel when the field name is not a noun", () => {
    render(
      <MessagingSurfacePicker fieldLabel="Add a channel or thread" searchLabel="Find a channel or thread" value="" options={options} filterConversations onChange={vi.fn()} />,
    );
    const trigger = screen.getByRole("button", { name: /^Add a channel or thread: / });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("combobox", { name: "Find a channel or thread" })).toHaveFocus();
  });

  it("leaves out manual entry when the caller cannot use a typed ID", () => {
    const onChange = vi.fn();
    render(
      <MessagingSurfacePicker fieldLabel="Surface" value="" options={options} filterConversations allowManual={false} onChange={onChange} />,
    );
    const trigger = screen.getByRole("button", { name: CLOSED_LABEL });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Surface" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter an ID manually..." })).not.toBeInTheDocument();
    // Nor does a search that matches nothing leave a way to choose "manual".
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "unknown" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("refuses to open while disabled, and keeps focus through the flip", () => {
    const props = { fieldLabel: "Surface", value: "", options, filterConversations: true, onChange: vi.fn() };
    const { rerender } = render(<MessagingSurfacePicker {...props} disabled />);
    const trigger = screen.getByRole("button", { name: CLOSED_LABEL });
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    // Never natively disabled: Chromium drops focus to <body> from a button
    // the moment it becomes `disabled`, and does not return it. A caller that
    // disables the field while its last pick saves would lose the operator's
    // place every time. jsdom does not model that focus fixup, so the
    // attribute is what this test can hold.
    expect(trigger).not.toBeDisabled();
    rerender(<MessagingSurfacePicker {...props} />);
    expect(trigger).not.toHaveAttribute("aria-disabled");
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Surface" })).toBeInTheDocument();
  });

  it("drops the kind glyph for container scopes, which are not channels", () => {
    render(
      <MessagingSurfacePicker
        fieldLabel="Surface"
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
