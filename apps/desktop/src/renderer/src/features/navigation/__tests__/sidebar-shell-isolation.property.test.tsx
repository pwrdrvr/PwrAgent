import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { Sidebar } from "../Sidebar";
import * as drag from "../../../lib/native-drag-interaction";

const noop = () => {};
const asyncNoop = async () => {};
const props: ComponentProps<typeof Sidebar> = {
  backends: [], browseMode: "inbox", directories: [], threads: [], inboxThreads: [], loading: false,
  onBrowseModeChange: noop, onSelectThread: noop, onCreateThread: asyncNoop, onOpenLaunchpad: asyncNoop,
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("isolates generated shell event-handler changes while dispatching the latest committed action", () => {
  fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1, maxLength: 20 }), (actions) => {
    const calls: number[] = [];
    const view = render(<Sidebar {...props} onOpenAutomations={() => calls.push(-1)} />);
    const renders = vi.spyOn(drag, "useNativeDragInteractionGuard");
    try {
      for (const action of actions) {
        view.rerender(<Sidebar {...props} onOpenAutomations={() => calls.push(action)} onCreateThread={async () => {}} />);
        expect(renders).not.toHaveBeenCalled();
        fireEvent.click(view.getByRole("button", { name: "Open automations" }));
        expect(calls[calls.length - 1]).toBe(action);
      }
    } finally { view.unmount(); vi.restoreAllMocks(); }
  }), { numRuns: 25 });
});

it("keeps the shrunk single shell event action out of the sidebar content", () => {
  const view = render(<Sidebar {...props} onOpenAutomations={noop} />);
  const renders = vi.spyOn(drag, "useNativeDragInteractionGuard");
  view.rerender(<Sidebar {...props} onOpenAutomations={() => {}} />);
  expect(renders).not.toHaveBeenCalled();
});

it("does not suppress changed functions that are read during rendering", () => {
  const view = render(<Sidebar {...props} readThreadWorktreeAvailability={async (thread) => ({ available: true, thread })} />);
  const renders = vi.spyOn(drag, "useNativeDragInteractionGuard");
  view.rerender(<Sidebar {...props} readThreadWorktreeAvailability={async (thread) => ({ available: false, thread })} />);
  expect(renders).toHaveBeenCalledTimes(1);
});

it("publishes event capability removal and restoration", () => {
  const view = render(<Sidebar {...props} onOpenAutomations={noop} />);
  const renders = vi.spyOn(drag, "useNativeDragInteractionGuard");
  view.rerender(<Sidebar {...props} onOpenAutomations={undefined} />);
  expect(renders).toHaveBeenCalledTimes(1);
  view.rerender(<Sidebar {...props} onOpenAutomations={noop} />);
  expect(renders).toHaveBeenCalledTimes(2);
});
