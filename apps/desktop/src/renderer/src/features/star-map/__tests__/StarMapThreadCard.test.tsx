import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { StarMapThreadCard } from "../StarMapThreadCard";

const { renderChips } = vi.hoisted(() => ({ renderChips: vi.fn() }));
vi.mock("../../navigation/ThreadMetaChips", () => ({
  ThreadMetaChips: (props: unknown) => {
    renderChips(props);
    return null;
  },
}));

type CardProps = ComponentProps<typeof StarMapThreadCard>;

function cardProps(): CardProps {
  return {
    thread: {
      id: "fixture",
      source: "codex",
      title: "Fixture",
      titleSource: "derived",
      linkedDirectories: [],
      inbox: { inInbox: false },
    } as NavigationThreadSummary,
    cardKey: "local::codex:fixture",
    baseSlot: { dx: 10, dy: 20 },
    offset: { dx: 2, dy: 3 },
    width: 200,
    stackIndex: 1,
    cardFields: {
      provider: false,
      branch: false,
      primaryDirectory: false,
      secondaryDirectories: false,
      terminalPullRequests: false,
    },
    onOpen: vi.fn(),
    onToggleSelect: vi.fn(),
    menuActions: [{ key: "action", label: "Fixture action", onSelect: vi.fn() }],
    drag: {
      detentRadius: 10000,
      scale: 1,
      snap: vi.fn((offset) => ({ ...offset, guides: [] })),
      onGuidesChange: vi.fn(),
      onGroupDelta: vi.fn(),
      onGroupCommit: vi.fn(),
      onCommitOffset: vi.fn(),
    },
  };
}

describe("StarMapThreadCard render boundary", () => {
  beforeEach(() => renderChips.mockClear());

  it("skips unchanged content while open, selection, menu and drag use the latest closures", async () => {
    const initial = cardProps();
    const { container, rerender } = render(<StarMapThreadCard {...initial} />);
    const latest = { ...cardProps(), thread: initial.thread };
    rerender(<StarMapThreadCard {...latest} />);
    expect(renderChips).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Open thread: Fixture" }));
    expect(latest.onOpen).toHaveBeenCalledWith(initial.thread);
    expect(initial.onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Fixture" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Fixture action" }));
    expect(latest.menuActions![0].onSelect).toHaveBeenCalledOnce();
    expect(initial.menuActions![0].onSelect).not.toHaveBeenCalled();

    const shell = container.querySelector<HTMLElement>("[data-card-key]")!;
    fireEvent.pointerDown(shell, { button: 0, shiftKey: true });
    expect(latest.onToggleSelect).toHaveBeenCalledOnce();
    expect(initial.onToggleSelect).not.toHaveBeenCalled();
    fireEvent.pointerDown(shell, { button: 0, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 110 });
    expect(latest.drag!.snap).toHaveBeenCalled();
    expect(latest.drag!.onGuidesChange).toHaveBeenCalled();
    expect(latest.drag!.onGroupDelta).toHaveBeenCalledWith({ dx: 20, dy: 10 });
    expect(latest.drag!.onGroupCommit).toHaveBeenCalledWith({ dx: 20, dy: 10 });
    expect(latest.drag!.onCommitOffset).toHaveBeenCalledWith({ dx: 22, dy: 13 });
    expect(initial.drag!.snap).not.toHaveBeenCalled();
    expect(initial.drag!.onCommitOffset).not.toHaveBeenCalled();
  });

  it("updates geometry, selection, data, fields and menu capabilities", () => {
    const initial = cardProps();
    const { container, rerender } = render(<StarMapThreadCard {...initial} />);
    rerender(<StarMapThreadCard {...initial} baseSlot={{ dx: 30, dy: 40 }} selected />);
    const shell = container.querySelector<HTMLElement>("[data-card-key]")!;
    expect(shell.style.left).toBe("32px");
    expect(shell.style.top).toBe("43px");
    expect(shell.className).toContain("star-map-card-shell--selected");
    expect(renderChips).toHaveBeenCalledTimes(2);

    rerender(<StarMapThreadCard {...initial}
      thread={{ ...initial.thread, title: "Changed" }}
      cardFields={{ ...initial.cardFields, provider: true }}
      menuActions={[{ key: "action", label: "Changed action", disabled: true, onSelect: vi.fn() }]}
    />);
    expect(screen.getByRole("button", { name: "Open thread: Changed" })).toBeTruthy();
    expect(renderChips.mock.lastCall![0].chipVisibility.provider).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Changed" }));
    expect((screen.getByRole("menuitem", {
      name: "Changed action",
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(renderChips).toHaveBeenCalledTimes(3);
  });

  it("does not hide scale or handler availability changes", async () => {
    const initial = cardProps();
    const { container, rerender } = render(<StarMapThreadCard {...initial} />);
    rerender(<StarMapThreadCard {...initial}
      onToggleSelect={undefined}
      drag={{ ...initial.drag!, scale: 2 }}
    />);
    expect(renderChips).toHaveBeenCalledTimes(2);
    const shell = container.querySelector<HTMLElement>("[data-card-key]")!;
    fireEvent.pointerDown(shell, { button: 0, shiftKey: true, clientX: 100, clientY: 100 });
    await act(async () => {
      fireEvent.pointerMove(window, { clientX: 120, clientY: 110 });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    fireEvent.pointerUp(window, { clientX: 120, clientY: 110 });
    expect(initial.onToggleSelect).not.toHaveBeenCalled();
    expect(initial.drag!.onCommitOffset).toHaveBeenCalledWith({ dx: 12, dy: 8 });
  });
});
