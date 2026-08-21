import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  NavigationDirectorySummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { CompactComposer } from "../CompactComposer";

function renderComposer(overrides: Partial<Parameters<typeof CompactComposer>[0]> = {}) {
  const onSend = vi.fn();
  const view = render(
    <CompactComposer onSend={onSend} threadTitle="Thread t1" {...overrides} />,
  );
  return { ...view, onSend };
}

/**
 * Paste is how the Tiptap suite drives markdown in: jsdom does not run the
 * `beforeinput` machinery typing-based input rules need, and the paste rules
 * exercise the same markdown parser.
 */
function pasteMarkdown(input: HTMLElement, text: string): void {
  fireEvent.paste(input, {
    clipboardData: {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
      items: [],
      types: ["text/plain"],
    },
  });
}

describe("CompactComposer", () => {
  it("sends on Enter and clears the draft", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "ship it" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("ship it");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps Shift+Enter as a newline", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send whitespace", () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not send on Enter while disabled", () => {
    // The button checks `disabled`; the key path has to agree. A disabled
    // `<textarea>` used to swallow the keydown natively, but the editor only
    // stops taking new text — a field focused before it was disabled still
    // forwards Enter.
    const { onSend } = renderComposer({ disabled: true });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "should not go" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("inserts a slash command from the shared autocomplete", async () => {
    renderComposer({
      mentionSources: {
        commands: [
          {
            name: "session-info",
            description: "Show ACP session details",
            sourceLabel: "Grok",
          },
        ],
      },
    });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "/ses" } });
    fireEvent.click(
      screen.getByRole("option", { name: /\/session-info/i }),
    );

    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("/session-info ");
    });
  });

  it("sends the highlighted slash command on the first Enter", async () => {
    const { onSend } = renderComposer({
      mentionSources: {
        commands: [
          {
            name: "review",
            description: "Review current changes",
            sourceLabel: "PwrAgent",
          },
          {
            name: "mcp",
            description: "List MCP tools",
            sourceLabel: "Codex",
          },
        ],
      },
    });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "/" } });
    expect(
      screen.getByRole("option", { name: /\/review/i }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith("/review");
    });
  });

  it.each([
    ["review", "PwrAgent"],
    ["compact", "Codex"],
  ])("sends exact /%s on the first Enter", async (command, sourceLabel) => {
    const { onSend } = renderComposer({
      mentionSources: {
        commands: [
          {
            name: command,
            description: `Run ${command}`,
            sourceLabel,
          },
        ],
      },
    });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: `/${command}` } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend).toHaveBeenCalledWith(`/${command}`);
    });
  });

  it("keeps Tab as autocomplete insertion for an exact slash command", async () => {
    const { onSend } = renderComposer({
      mentionSources: {
        commands: [
          {
            name: "review",
            description: "Review current changes",
            sourceLabel: "PwrAgent",
          },
        ],
      },
    });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "/review" } });
    fireEvent.keyDown(input, { key: "Tab" });

    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe("/review ");
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows model, effort, and access mode as the status chip", () => {
    renderComposer({
      executionMode: "full-access",
      model: "gpt-5-codex",
      reasoningEffort: "high",
    });
    // Segments, not one joined string: the access segment carries its own
    // warning treatment. Labels come from formatExecutionModeLabel so every
    // surface names the modes identically.
    expect(screen.getByText("gpt-5-codex")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("Full Access")).toBeTruthy();
  });

  it("omits optional chip and menu chrome when unconfigured", () => {
    renderComposer();
    expect(
      screen.getByRole("textbox", { name: "Message Thread t1" }),
    ).toBeTruthy();
    expect(screen.queryByText(/·/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Thread settings" }),
    ).toBeNull();
  });

  it("keeps the chip informational when there is nothing to open", () => {
    // Model info with no settings callbacks and no actions: readout only,
    // no menu trigger.
    renderComposer({ model: "gpt-5-codex" });
    expect(screen.getByText("gpt-5-codex")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Thread settings" }),
    ).toBeNull();
  });

  it("offers Steer alongside Stop while a turn is running", () => {
    const onInterrupt = vi.fn();
    renderComposer({ busy: true, onInterrupt });
    // Stop used to be the only control, which read as "you cannot say
    // anything until this finishes".
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("steers the typed text into the running turn", async () => {
    const { onSend } = renderComposer({ busy: true, onInterrupt: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "also check the logs" } });
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("also check the logs");
    });
  });

  it("disables Steer when the running turn cannot take one", () => {
    renderComposer({ busy: true, canSteer: false, onInterrupt: vi.fn() });
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    fireEvent.change(input, { target: { value: "no route for this" } });
    // Better a dead button than a send that is guaranteed to bounce.
    expect(
      (screen.getByRole("button", { name: "Steer" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps Stop hidden when the host offers no way to interrupt", () => {
    renderComposer({ busy: true });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("runs a secondary action and closes the menu", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [{ key: "a", label: "Compact thread", onSelect }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compact thread" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu on Escape without running anything", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [{ key: "a", label: "Compact thread", onSelect }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread settings" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders a disabled action as unclickable", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [
        { disabled: true, key: "a", label: "Compact thread", onSelect },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Thread settings" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compact thread" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("CompactComposer settings menu", () => {
  const settingsMenu = (
    overrides: Partial<
      NonNullable<Parameters<typeof CompactComposer>[0]["settingsMenu"]>
    > = {},
  ) => ({
    executionModes: [
      { label: "Default Access", mode: "default" as const },
      { label: "Full Access", mode: "full-access" as const },
    ],
    models: [
      { id: "gpt-5-codex", label: "gpt-5-codex" },
      { id: "gpt-5-spark" },
    ],
    reasoningEfforts: ["low", "medium", "high"],
    supportsFastMode: true,
    onSelectExecutionMode: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectReasoningEffort: vi.fn(),
    onToggleFastMode: vi.fn(),
    ...overrides,
  });

  function openMenu() {
    // The chip's accessible name carries the visible readout after the
    // "Thread settings:" prefix (label-in-name), so match on the prefix.
    fireEvent.click(screen.getByRole("button", { name: /^Thread settings/ }));
  }

  it("asks the host to load options when the menu opens", () => {
    // Lazy on purpose: a card the operator only reads must not pay for a
    // backend describe it never shows.
    const onOpen = vi.fn();
    renderComposer({ settingsMenu: settingsMenu({ onOpen }) });
    expect(onOpen).not.toHaveBeenCalled();
    openMenu();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("selects a model from the submenu and closes", () => {
    const menu = settingsMenu();
    renderComposer({ model: "gpt-5-codex", settingsMenu: menu });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    const current = screen.getByRole("menuitemradio", { name: "gpt-5-codex" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "gpt-5-spark" }));
    expect(menu.onSelectModel).toHaveBeenCalledWith("gpt-5-spark");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("selects a reasoning effort from the submenu", () => {
    const menu = settingsMenu();
    renderComposer({ reasoningEffort: "high", settingsMenu: menu });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Reasoning/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "medium" }));
    expect(menu.onSelectReasoningEffort).toHaveBeenCalledWith("medium");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("toggles fast mode in place without closing the menu", () => {
    const menu = settingsMenu();
    renderComposer({ fastMode: false, settingsMenu: menu });
    openMenu();
    const toggle = screen.getByRole("menuitemcheckbox", { name: "Fast mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(menu.onToggleFastMode).toHaveBeenCalledWith(true);
    // Still open: a toggle is not a leaf selection.
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("switches access mode from the submenu", () => {
    const menu = settingsMenu();
    renderComposer({ executionMode: "default", settingsMenu: menu });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Access/ }));
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Full Access" }),
    );
    expect(menu.onSelectExecutionMode).toHaveBeenCalledWith("full-access");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps setting rows visible and reports a failed option load", () => {
    // A failed describe must not make the rows silently vanish — the
    // submenu says the load failed instead.
    renderComposer({
      settingsMenu: settingsMenu({
        loadFailed: true,
        loading: false,
        models: undefined,
        reasoningEfforts: undefined,
      }),
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    expect(screen.getByText("Couldn't load options.")).toBeTruthy();
  });

  it("returns to the root view through Back", () => {
    renderComposer({ settingsMenu: settingsMenu() });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
    expect(screen.getByRole("menuitem", { name: /Reasoning/ })).toBeTruthy();
  });

  it("reopens on the root view after browsing a submenu", () => {
    renderComposer({ settingsMenu: settingsMenu() });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    openMenu();
    expect(screen.getByRole("menuitem", { name: /Model/ })).toBeTruthy();
  });

  it("reports a still-loading submenu instead of an empty list", () => {
    renderComposer({
      settingsMenu: settingsMenu({ loading: true, models: undefined }),
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Model/ }));
    expect(screen.getByText("Loading options…")).toBeTruthy();
  });

  it("hides setting sections whose options cannot load", () => {
    // No models, no efforts, nothing loading: only Access has anything to
    // offer, so Model and Reasoning rows do not render at all.
    renderComposer({
      settingsMenu: settingsMenu({
        loading: false,
        models: [],
        reasoningEfforts: [],
        supportsFastMode: false,
      }),
    });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /Model/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Reasoning/ })).toBeNull();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Fast mode" }),
    ).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Access/ })).toBeTruthy();
  });

  it("separates settings from host actions in one menu", () => {
    const onSelect = vi.fn();
    renderComposer({
      secondaryActions: [
        { key: "open-full", label: "Open in full view", onSelect },
      ],
      settingsMenu: settingsMenu(),
    });
    openMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in full view" }),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("CompactComposer markdown", () => {
  it("formats inline code rather than leaving the backticks literal", async () => {
    const { container } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "Can you deploy `pr-13598-3f3b862d1163`");

    // The card renders a fully formatted transcript; a reply box that
    // cannot format teaches the operator that markdown does not work here.
    await waitFor(() => {
      expect(container.querySelector("code")?.textContent).toBe(
        "pr-13598-3f3b862d1163",
      );
    });
  });

  it("sends the markdown source, not the rendered text", async () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "run `pnpm test` first");

    await waitFor(() => {
      expect(input.textContent).toContain("pnpm test");
    });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      // The backend reads markdown, so the backticks have to survive the
      // trip through the editor.
      expect(onSend).toHaveBeenCalledWith("run `pnpm test` first");
    });
  });

  it("keeps a fenced block intact across the send", async () => {
    const { onSend } = renderComposer();
    const input = screen.getByRole("textbox", { name: "Message Thread t1" });
    pasteMarkdown(input, "```sh\npnpm lint\n```");

    await waitFor(() => {
      expect(input.querySelector("pre code")?.textContent).toContain(
        "pnpm lint",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("```sh\npnpm lint\n```");
    });
  });

  describe("mentions", () => {
    const SKILLS = [
      { name: "deploy", path: "/skills/deploy.md", shortDescription: "Ship it" },
      { name: "debug", path: "/skills/debug.md" },
    ];
    function thread(
      overrides: Partial<NavigationThreadSummary>,
    ): NavigationThreadSummary {
      return {
        titleSource: "generated",
        source: "codex",
        linkedDirectories: [],
        inbox: { inInbox: false },
        updatedAt: 1,
        ...overrides,
      } as NavigationThreadSummary;
    }

    function openPicker(value: string) {
      const input = screen.getByRole("textbox", { name: "Message Thread t1" });
      fireEvent.change(input, { target: { value } });
      return input;
    }

    it("leaves every trigger literal when no sources are supplied", () => {
      // The default has to stay exactly what it was before mentions
      // existed: `CompactComposer` is shared, and a host that knows
      // nothing about `mentionSources` must not start opening pickers.
      const { onSend } = renderComposer();
      const input = openPicker("ask $deploy about @app and #42");
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("ask $deploy about @app and #42");
    });

    it("opens the skill picker on $ and serializes the chip as markdown", () => {
      const { container, onSend } = renderComposer({
        mentionSources: { skills: SKILLS },
      });
      const input = openPicker("run $dep");
      const options = screen.getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "$deployShip it",
      ]);

      fireEvent.click(options[0]!);
      // The chip is zero-width in the plain draft, so the rendered mention
      // node is the only evidence it landed as a chip and not as text.
      expect(
        container.querySelector(".composer-tiptap-input__mention")?.textContent,
      ).toBe("$deploy");

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("run [$deploy](/skills/deploy.md)");
    });

    it("opens the directory picker on @ and serializes a tilde link", () => {
      const { onSend } = renderComposer({
        mentionSources: {
          directories: [
            {
              key: "d-app",
              kind: "directory",
              label: "app",
              path: "/dev/app",
            } as NavigationDirectorySummary,
          ],
        },
      });
      const input = openPicker("look in @ap");
      fireEvent.click(screen.getByRole("option"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("look in [@app](/dev/app)");
    });

    it("offers threads on # and serializes the thread url", () => {
      const { onSend } = renderComposer({
        mentionSources: {
          threads: [thread({ id: "t-42", title: "Ship the release" })],
        },
      });
      const input = openPicker("see #Ship");
      fireEvent.click(screen.getByRole("option"));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith(
        "see [Ship the release](pwragent://thread/t-42?backend=codex)",
      );
    });

    it("offers a pull request on a numeric # and keeps its url", () => {
      const { onSend } = renderComposer({
        mentionSources: {
          threads: [
            thread({
              id: "t-42",
              title: "Ship the release",
              prs: [
                {
                  provider: "github.com",
                  state: "passing",
                  number: 118,
                  org: "pwrdrvr",
                  repo: "PwrAgnt",
                  title: "Fix the thing",
                  url: "https://github.com/pwrdrvr/PwrAgnt/pull/118",
                },
              ],
            }),
          ],
        },
      });
      const input = openPicker("about #118");
      const pullRequest = screen
        .getAllByRole("option")
        .find((option) => option.textContent?.startsWith("#118"));
      fireEvent.click(pullRequest!);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith(
        "about [#118](https://github.com/pwrdrvr/PwrAgnt/pull/118)",
      );
    });

    it("keeps a trigger with no matches as literal text", () => {
      const { onSend } = renderComposer({
        mentionSources: { skills: SKILLS },
      });
      const input = openPicker("run $nothinghere");
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("run $nothinghere");
    });

    it("gives arrows and Enter to the picker before the send path", () => {
      const { onSend } = renderComposer({
        mentionSources: { skills: SKILLS },
      });
      const input = openPicker("run $de");
      expect(screen.getAllByRole("option")).toHaveLength(2);

      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      // Enter committed the second row instead of sending the draft.
      expect(onSend).not.toHaveBeenCalled();

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("run [$debug](/skills/debug.md)");
    });

    it("hands Enter back to the send path once Escape closes the picker", () => {
      const { onSend } = renderComposer({
        mentionSources: { skills: SKILLS },
      });
      const input = openPicker("run $dep");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith("run $dep");
    });

    it("reopens for the same query later in the same message", () => {
      // Dismissing one `$dep` must not retire every later `$dep`. Keyed on
      // the query alone, Escape poisoned that word for the rest of the
      // message and the picker silently refused to open again.
      const { onSend } = renderComposer({ mentionSources: { skills: SKILLS } });
      const input = openPicker("run $dep");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();

      fireEvent.change(input, { target: { value: "run $dep and $dep" } });
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(onSend).not.toHaveBeenCalled();
    });

    it("reopens after backspacing over a dismissed trigger and retyping", () => {
      const { onSend } = renderComposer({ mentionSources: { skills: SKILLS } });
      const input = openPicker("run $dep");
      fireEvent.keyDown(input, { key: "Escape" });

      // Same offsets as the dismissed trigger, so only retiring the
      // dismissal when the trigger moves gets this right.
      fireEvent.change(input, { target: { value: "run $de" } });
      fireEvent.change(input, { target: { value: "run $dep" } });
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(onSend).not.toHaveBeenCalled();
    });

    it("still closes on Escape once focus has left the editor", () => {
      // The popover deliberately survives a blur, so the editor's key
      // handler is out of the loop — without a window-scope listener the
      // list sits over the card's transcript with no way to dismiss it.
      renderComposer({ mentionSources: { skills: SKILLS } });
      openPicker("run $dep");
      expect(screen.getByRole("listbox")).toBeTruthy();

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("does not open a picker on a disabled composer", () => {
      // A disabled composer still forwards keys from a field focused
      // before it was disabled, so an un-gated popover would let Enter
      // commit a chip into a composer that is refusing new text.
      renderComposer({ disabled: true, mentionSources: { skills: SKILLS } });
      const input = screen.getByRole("textbox", {
        name: "Message Thread t1",
      });
      fireEvent.change(input, { target: { value: "run $dep" } });
      expect(screen.queryByRole("listbox")).toBeNull();
    });

    it("keeps a consumed Escape from reaching the host", () => {
      // The star map layer's Escape handler sits on an ancestor and clears
      // the operator's gathered card selection. Closing a popover is not
      // also a request to drop that selection.
      const onKeyDown = vi.fn();
      render(
        <div onKeyDown={onKeyDown}>
          <CompactComposer
            mentionSources={{ skills: SKILLS }}
            onSend={vi.fn()}
            threadTitle="Thread t1"
          />
        </div>,
      );
      const input = screen.getByRole("textbox", {
        name: "Message Thread t1",
      });
      fireEvent.change(input, { target: { value: "run $dep" } });
      onKeyDown.mockClear();

      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it("points the editor at the open listbox and its active row", () => {
      renderComposer({ mentionSources: { skills: SKILLS } });
      const input = openPicker("run $de");
      const listbox = screen.getByRole("listbox");
      expect(input.getAttribute("aria-controls")).toBe(listbox.id);
      expect(input.getAttribute("aria-activedescendant")).toBe(
        screen.getAllByRole("option")[0]!.id,
      );
    });

    it("asks the host to load a population when a trigger opens", () => {
      // Lazy on purpose: a card the operator only reads must not pay for a
      // skill list or a navigation snapshot it never shows.
      const ensureSkillsLoaded = vi.fn();
      const ensureNavigationLoaded = vi.fn();
      renderComposer({
        mentionSources: { ensureNavigationLoaded, ensureSkillsLoaded },
      });
      expect(ensureSkillsLoaded).not.toHaveBeenCalled();
      expect(ensureNavigationLoaded).not.toHaveBeenCalled();

      openPicker("run $de");
      expect(ensureSkillsLoaded).toHaveBeenCalled();
      expect(ensureNavigationLoaded).not.toHaveBeenCalled();

      openPicker("look in @ap");
      expect(ensureNavigationLoaded).toHaveBeenCalled();
    });

    it("keeps two chips at their own offsets in one draft", async () => {
      // Where the index math breaks if it breaks: a chip is zero-width in
      // the plain draft, so the second insert has to shift nothing and the
      // serializer has to splice both back at the right offsets.
      const { onSend } = renderComposer({
        mentionSources: {
          directories: [
            {
              key: "d-app",
              kind: "directory",
              label: "app",
              path: "/dev/app",
            } as NavigationDirectorySummary,
          ],
          skills: SKILLS,
        },
      });
      const input = openPicker("run $dep");
      fireEvent.click(screen.getByRole("option"));

      // Paste, not `change`: the test-only value setter replaces the whole
      // document and would drop the chip already in it.
      pasteMarkdown(input, "over @ap");
      fireEvent.click(await screen.findByRole("option"));

      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSend).toHaveBeenCalledWith(
        "run [$deploy](/skills/deploy.md) over [@app](/dev/app)",
      );
    });

    it("puts a bounced send back with its chips intact", async () => {
      const onSend = vi.fn(async () => false);
      const { container } = render(
        <CompactComposer
          mentionSources={{ skills: SKILLS }}
          onSend={onSend}
          threadTitle="Thread t1"
        />,
      );
      const input = openPicker("run $dep");
      fireEvent.click(screen.getByRole("option"));
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(
          container.querySelector(".composer-tiptap-input__mention")?.textContent,
        ).toBe("$deploy");
      });
    });
  });
});
