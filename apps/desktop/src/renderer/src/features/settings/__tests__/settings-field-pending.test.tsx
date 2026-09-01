import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SegmentedControl,
  SegmentedField,
  SettingsField,
  ToggleField,
} from "../SettingsLayout";

afterEach(() => {
  cleanup();
});

/** A write whose settle point the test controls, standing in for the
 *  config-write + adapter-reload round trip a real toggle triggers. */
function deferred<TValue = void>(): {
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: TValue) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function pendingIndicator(): HTMLElement | null {
  return document.querySelector(".settings-pending");
}

function spinner(): HTMLElement | null {
  return document.querySelector(".settings-pending .pending-spinner");
}

const MODES = [
  { label: "Every message", value: "every_message" },
  { label: "@ mention only", value: "mention_only" },
] as const;

describe("settings field pending state", () => {
  it("shows pending on the toggle that was actuated and clears it on success", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Slack" });
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(spinner()).toBeNull();
    expect(pendingIndicator()).toBeNull();

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });
    expect(toggle).toHaveAttribute("aria-busy", "true");
    expect(pendingIndicator()).toHaveTextContent("Saving…");

    await act(async () => {
      write.resolve();
      await write.promise;
    });

    expect(spinner()).toBeNull();
    expect(toggle).not.toHaveAttribute("aria-busy");
    expect(pendingIndicator()).toBeNull();
  });

  it("clears the toggle's pending state when the write fails", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));
    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });

    await act(async () => {
      write.reject(new Error("config write failed"));
      await write.promise.catch(() => undefined);
    });

    // The row goes back to rest even though the value never changed — a
    // spinner left spinning reads as a save that is still running.
    expect(spinner()).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Slack" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("clears pending when the write resolves false, the way writeConfig fails", async () => {
    // `writeConfig` catches its own errors and resolves `false` — it never
    // rejects — so the rejecting test above does not cover the shape the app
    // actually produces. The row has to come back to rest either way.
    const write = deferred<boolean>();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));
    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });

    await act(async () => {
      write.resolve(false);
      await write.promise;
    });

    expect(spinner()).toBeNull();
    expect(
      screen.getByRole("switch", { name: "Slack" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("marks the segment still writing, not the one clicked last", async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    render(
      <SegmentedField
        label="Tool updates"
        options={[
          { label: "Every message", value: "every" },
          { label: "@ mention only", value: "mention" },
          { label: "Off", value: "off" },
        ]}
        source="config"
        value="off"
        onChange={() => writes.shift()?.promise ?? Promise.resolve()}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Every message" }));
    fireEvent.click(screen.getByRole("radio", { name: "@ mention only" }));

    // The second pick settles first; the first write is still out.
    await act(async () => {
      second.resolve();
      await second.promise;
    });

    expect(
      screen.getByRole("radio", { name: "Every message" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("radio", { name: "@ mention only" }),
    ).not.toHaveAttribute("aria-busy");
    expect(spinner()).toBeInTheDocument();

    await act(async () => {
      first.resolve();
      await first.promise;
    });

    expect(spinner()).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Every message" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("does not announce a save when the selected segment is re-clicked", () => {
    const onChange = vi.fn(() => Promise.resolve());
    render(
      <SegmentedField
        label="Tool updates"
        options={[
          { label: "Every message", value: "every" },
          { label: "Off", value: "off" },
        ]}
        source="config"
        value="off"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));

    // Several panes route through a delta builder that bails when nothing
    // moved, so a tracked re-click would show "Saving…" for no write at all.
    expect(onChange).not.toHaveBeenCalled();
    expect(spinner()).toBeNull();
    expect(document.querySelector(".settings-pending")).toBeNull();
  });

  it("renders an option's meta as a stacked segment", () => {
    render(
      <SegmentedField
        label="Release channel"
        options={[
          { label: "Stable", meta: "1.2.0", value: "stable" },
          { label: "Beta", meta: "1.3.0-beta.1", value: "beta" },
        ]}
        source="config"
        value="stable"
        onChange={() => Promise.resolve()}
      />,
    );

    const stable = screen.getByRole("radio", { name: /Stable/ });
    expect(stable.className).toContain("settings-segmented__button--stacked");
    expect(stable).toHaveTextContent("1.2.0");

    // An option with no meta stays on the plain variant, so the two shapes
    // cannot drift apart behind a separate flag.
    cleanup();
    render(
      <SegmentedField
        label="Release channel"
        options={[{ label: "Stable", value: "stable" }]}
        source="config"
        value="stable"
        onChange={() => Promise.resolve()}
      />,
    );
    expect(
      screen.getByRole("radio", { name: "Stable" }).className,
    ).not.toContain("--stacked");
  });

  it("shows no affordance for a control that opted out of tracking", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Theme"
        options={[
          { label: "System", value: "system" },
          { label: "Dark", value: "dark" },
        ]}
        value="system"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

    // Appearance axes apply optimistically, so there is no wait to report.
    expect(onChange).toHaveBeenCalledWith("dark");
    expect(document.querySelector(".settings-pending")).toBeNull();
    expect(
      screen.getByRole("radio", { name: "Dark" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("leaves a sibling field untouched while one field saves", async () => {
    const write = deferred();
    render(
      <>
        <ToggleField
          checked={false}
          label="Slack"
          source="config"
          onChange={() => write.promise}
        />
        <ToggleField
          checked={false}
          label="Discord"
          source="config"
          onChange={() => Promise.resolve()}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));

    await waitFor(() => {
      expect(document.querySelectorAll(".pending-spinner")).toHaveLength(1);
    });
    expect(screen.getByRole("switch", { name: "Slack" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Discord" })).not.toHaveAttribute(
      "aria-busy",
    );

    await act(async () => {
      write.resolve();
      await write.promise;
    });
  });

  it("marks the segmented option the operator picked as busy", async () => {
    const write = deferred();
    render(
      <SegmentedField
        label="Response mode"
        options={[...MODES]}
        source="config"
        value="every_message"
        onChange={() => write.promise}
      />,
    );

    const picked = screen.getByRole("radio", { name: "@ mention only" });
    const other = screen.getByRole("radio", { name: "Every message" });

    fireEvent.click(picked);

    await waitFor(() => {
      expect(picked).toHaveAttribute("aria-busy", "true");
    });
    expect(other).not.toHaveAttribute("aria-busy");
    expect(pendingIndicator()).toHaveTextContent("Saving…");

    await act(async () => {
      write.resolve();
      await write.promise;
    });

    expect(picked).not.toHaveAttribute("aria-busy");
    expect(spinner()).toBeNull();
  });

  it("holds pending until the last of two overlapping writes settles", async () => {
    const first = deferred();
    const second = deferred();
    const writes = [first, second];
    let call = 0;
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => writes[call++].promise}
      />,
    );

    const toggle = screen.getByRole("switch", { name: "Slack" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(spinner()).toBeInTheDocument();
    });

    await act(async () => {
      first.resolve();
      await first.promise;
    });
    // One write is still out; clearing here would call the save done early.
    expect(spinner()).toBeInTheDocument();

    await act(async () => {
      second.resolve();
      await second.promise;
    });
    expect(spinner()).toBeNull();
  });

  it("announces the pending state, and stands down no announcer at rest", async () => {
    const write = deferred();
    render(
      <ToggleField
        checked={false}
        label="Slack"
        source="config"
        onChange={() => write.promise}
      />,
    );

    // A pane holds dozens of these fields, so an idle one must not leave a
    // standing live region behind — settings-screen.test.tsx queries
    // `getByRole("status")` expecting the pane's own single announcer.
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Slack" }));

    let status: HTMLElement | undefined;
    await waitFor(() => {
      status = screen.getByRole("status");
      expect(status).toHaveTextContent("Saving…");
    });
    // The ring itself is decorative; the text is what carries the state.
    expect(status?.querySelector(".pending-spinner")).toHaveAttribute(
      "aria-hidden",
      "true",
    );

    await act(async () => {
      write.resolve();
      await write.promise;
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives the switch its own accessible name when the row label needs context", () => {
    render(
      <ToggleField
        checked={false}
        label="Enabled"
        switchQualifier="Grok"
        source="config"
        onChange={() => Promise.resolve()}
      />,
    );

    // The row reads "Enabled" beside its card heading, so the switch has to
    // name the agent to stand alone in a screen reader's control list — but
    // WCAG 2.5.3 Label in Name requires the visible text to survive inside
    // the accessible name, or Voice Control's "click Enabled" matches nothing.
    const toggle = screen.getByRole("switch", { name: "Enabled — Grok" });
    expect(toggle).toBeInTheDocument();
    expect(toggle.getAttribute("aria-label")).toContain("Enabled");
  });

  it("keeps a toggle's actions out of the control row", () => {
    render(
      <ToggleField
        actions={<button type="button">Apply to launchpads</button>}
        checked={false}
        label="Enable Auto-fix PR"
        source="config"
        onChange={() => Promise.resolve()}
      />,
    );

    const row = document.querySelector(".settings-control-row");
    expect(row?.querySelector("button[type='button']:not([role='switch'])")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Apply to launchpads" }),
    ).toBeInTheDocument();
  });

  it("renders no pending affordance for a field that did not opt in", () => {
    render(
      <>
        <SettingsField
          label="Workspace URL"
          control={<input aria-label="Workspace URL" />}
        />
        <SettingsField
          label="Signing secret"
          pending={false}
          control={<input aria-label="Signing secret" />}
        />
      </>,
    );

    // Both halves matter: asserting only absence would keep passing if the
    // whole affordance were deleted, so the opted-in field has to prove the
    // row is there to be absent from.
    const rows = document.querySelectorAll(".settings-control-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector("input[aria-label='Signing secret']")).not.toBeNull();
    expect(document.querySelector(".settings-pending")).toBeNull();
  });

  it("keeps a segmented field's actions out of the control row", () => {
    render(
      <SegmentedField
        actions={<button type="button">Reset bindings</button>}
        label="Working Updates"
        options={[...MODES]}
        source="config"
        value="every_message"
        onChange={() => Promise.resolve()}
      />,
    );

    const row = document.querySelector(".settings-control-row");
    expect(row).not.toBeNull();
    // The row is the control + indicator pair; a follow-on action button
    // sitting inside it would be pushed onto the same line as the group.
    expect(
      row?.querySelector("button[type='button']:not([role='radio'])"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Reset bindings" }),
    ).toBeInTheDocument();
  });
});
