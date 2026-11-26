import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type {
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import { TranscriptList } from "../TranscriptList";

const SAMPLE_SCREENSHOT =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==";

const marker = '::browser-complete{title="Verified preview"}';
const completion: AppServerThreadMessageEntry = {
  type: "message",
  id: "browser-completion",
  role: "assistant",
  phase: "commentary",
  text: marker,
  turn: { id: "browser-turn", status: "in_progress" },
};
const listProps = { loading: false, loadingMore: false, onLoadOlder: async () => undefined };

it("renders the browser headline as activity in the original transcript row", () => {
  const view = render(
    <TranscriptList {...listProps} activeTurnId="browser-turn"
      entries={[completion]} parentThreadBackend="codex" />,
  );
  try {
    const row = view.getByRole("listitem");
    expect(row).toHaveAttribute("data-entry-id", "browser-completion");
    expect(within(row).getByText("Verified preview")).toHaveClass("transcript-activity__label");
    expect(within(row).queryByText(marker)).toBeNull();
    // Standalone marker with missing metadata fabricates no surface chip or URL.
    expect(row.querySelector(".transcript-browser-use__meta")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("renders the same activity when expanding a reopened transcript", () => {
  const view = render(
    <TranscriptList {...listProps} entries={[{
      ...completion,
      turn: { id: "browser-turn", status: "completed" },
    }]} parentThreadBackend="codex" />,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "1 previous message" }));
    expect(view.getByText("Verified preview")).toHaveClass("transcript-activity__label");
    expect(view.queryByText(marker)).toBeNull();
  } finally {
    view.unmount();
  }
});

it("associates ::browser-complete with a prior browser activity, renders surface context and preview, and preserves subsequent work", () => {
  const onOpenImage = vi.fn();
  const entries: AppServerThreadEntry[] = [
    {
      type: "message",
      id: "user-1",
      role: "user",
      text: "Verify the checkout preview on localhost:3000",
      turn: { id: "turn-1", status: "in_progress" },
    },
    {
      type: "activity",
      id: "activity-browser-1",
      summary: "Browsed localhost:3000",
      status: "completed",
      turn: { id: "turn-1", status: "in_progress" },
      details: [
        {
          id: "call-1",
          kind: "command",
          label: "Open checkout page",
          status: "completed",
          command: {
            displayCommand: 'node_repl/js\n{"title":"Open checkout page"}',
            rawCommand: "node_repl/js",
            source: "tool",
            output: "Loaded checkout",
          },
          browserUse: {
            backend: "iab",
            browserId: "iab",
            url: "http://localhost:3000/cart",
          },
        },
        {
          id: "call-2",
          kind: "command",
          label: "Inspect submit button",
          status: "completed",
          command: {
            displayCommand: 'node_repl/js\n{"title":"Inspect submit button"}',
            rawCommand: "node_repl/js",
            source: "tool",
            output: "Submit button enabled",
          },
          browserUse: {
            backend: "iab",
            browserId: "iab",
            url: "http://localhost:3000/checkout",
            screenshotUrl: SAMPLE_SCREENSHOT,
            webMcpTools: [{ name: "checkout_submit", title: "Submit checkout" }],
          },
        },
      ],
    },
    {
      type: "message",
      id: "bc-1",
      role: "assistant",
      phase: "commentary",
      text: '::browser-complete{title="Verified checkout preview"}',
      turn: { id: "turn-1", status: "in_progress" },
    },
    {
      type: "activity",
      id: "activity-after",
      summary: "Ran 1 command",
      status: "completed",
      turn: { id: "turn-1", status: "in_progress" },
      details: [
        {
          id: "cmd-1",
          kind: "command",
          label: "git diff --stat",
          status: "completed",
          command: { displayCommand: "git diff --stat", rawCommand: "git diff --stat" },
        },
      ],
    },
  ];

  const view = render(
    <TranscriptList
      {...listProps}
      activeTurnId="turn-1"
      entries={entries}
      onOpenImage={onOpenImage}
      parentThreadBackend="codex"
    />,
  );
  try {
    const items = view.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "user-1",
      "activity-browser-1",
      "activity-after",
    ]);

    const browserRow = items[1]!;
    expect(within(browserRow).getByText("Verified checkout preview")).toHaveClass("transcript-activity__label");
    expect(within(browserRow).getByText("In-app browser")).toBeInTheDocument();
    const urlLink = within(browserRow).getByRole("link", { name: "localhost:3000/checkout" });
    expect(urlLink).toHaveAttribute("href", "http://localhost:3000/checkout");
    expect(within(browserRow).getByText("2 steps")).toBeInTheDocument();
    expect(within(browserRow).getByText("WebMCP: Submit checkout")).toBeInTheDocument();

    fireEvent.click(within(browserRow).getByRole("button", { name: "Expand browser preview for Verified checkout preview" }));
    expect(onOpenImage).toHaveBeenCalledWith({
      type: "image",
      url: SAMPLE_SCREENSHOT,
      alt: "Verified checkout preview screenshot",
    });

    fireEvent.click(within(browserRow).getByRole("button", { name: "Verified checkout preview" }));
    expect(within(browserRow).getByText("Open checkout page")).toBeInTheDocument();
    expect(within(browserRow).getByText("Inspect submit button")).toBeInTheDocument();

    expect(within(items[2]!).getByText("Ran 1 command")).toBeInTheDocument();
    expect(view.queryByText(/::browser-complete/)).toBeNull();
  } finally {
    view.unmount();
  }
});

it("supports sign-in pauses with an intervening mailbox connector call and a second browser phase in the same turn", () => {
  const entries: AppServerThreadEntry[] = [
    {
      type: "activity",
      id: "activity-login",
      summary: "Paused for sign-in",
      status: "completed",
      turn: { id: "turn-auth", status: "in_progress" },
      details: [
        {
          id: "call-login",
          kind: "command",
          label: "Open billing sign-in",
          status: "completed",
          browserUse: {
            backend: "chrome",
            browserFamily: "chrome",
            browserId: "chrome-1",
            url: "https://billing.example.com/login",
            handoffReason: "authentication",
          },
        },
      ],
    },
    {
      type: "activity",
      id: "activity-mail",
      summary: "Used MCP gmail/search",
      status: "completed",
      turn: { id: "turn-auth", status: "in_progress" },
      details: [
        {
          id: "call-mail",
          kind: "command",
          label: "Used MCP gmail/search",
          status: "completed",
          command: { displayCommand: "gmail/search", rawCommand: "gmail/search", source: "tool" },
        },
      ],
    },
    {
      type: "message",
      id: "bc-pause",
      role: "assistant",
      phase: "commentary",
      text: '::browser-complete{title="Paused for a sign-in code"}',
      turn: { id: "turn-auth", status: "in_progress" },
    },
    {
      type: "message",
      id: "commentary-mid",
      role: "assistant",
      phase: "commentary",
      text: "Continuing after code entry.",
      turn: { id: "turn-auth", status: "in_progress" },
    },
    {
      type: "activity",
      id: "activity-invoices",
      summary: "Browsed billing.example.com",
      status: "completed",
      turn: { id: "turn-auth", status: "in_progress" },
      details: [
        {
          id: "call-invoices",
          kind: "command",
          label: "Read latest invoice",
          status: "completed",
          browserUse: {
            backend: "chrome",
            browserFamily: "chrome",
            browserId: "chrome-1",
            url: "https://billing.example.com/invoices",
          },
        },
      ],
    },
    {
      type: "message",
      id: "bc-done",
      role: "assistant",
      phase: "commentary",
      text: '::browser-complete{title="Downloaded October invoice"}',
      turn: { id: "turn-auth", status: "in_progress" },
    },
  ];

  const view = render(
    <TranscriptList
      {...listProps}
      activeTurnId="turn-auth"
      entries={entries}
      parentThreadBackend="codex"
    />,
  );
  try {
    const items = view.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "activity-login",
      "activity-mail",
      "commentary-mid",
      "activity-invoices",
    ]);
    expect(within(items[0]!).getByText("Paused for a sign-in code")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Sign-in required")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Chrome")).toBeInTheDocument();
    expect(within(items[1]!).getByText("Used MCP gmail/search")).toBeInTheDocument();
    expect(within(items[2]!).getByText("Continuing after code entry.")).toBeInTheDocument();
    expect(within(items[3]!).getByText("Downloaded October invoice")).toBeInTheDocument();
  } finally {
    view.unmount();
  }
});

it("keeps a standalone marker separate when browser surface metadata is ambiguous or missing", () => {
  const entries: AppServerThreadEntry[] = [
    {
      type: "activity",
      id: "activity-multi-surface",
      summary: "Browsed example.com",
      status: "completed",
      turn: { id: "turn-ambig", status: "in_progress" },
      details: [
        {
          id: "call-iab",
          kind: "command",
          label: "In-app browser · example.com/a",
          status: "completed",
          browserUse: { backend: "iab", browserId: "iab", url: "https://example.com/a" },
        },
        {
          id: "call-chrome",
          kind: "command",
          label: "Chrome · example.com/b",
          status: "completed",
          browserUse: { backend: "chrome", browserFamily: "chrome", browserId: "chrome-1", url: "https://example.com/b" },
        },
      ],
    },
    {
      type: "message",
      id: "bc-ambig",
      role: "assistant",
      phase: "commentary",
      text: '::browser-complete{title="Checked pricing page"}',
      turn: { id: "turn-ambig", status: "in_progress" },
    },
  ];

  const view = render(
    <TranscriptList
      {...listProps}
      activeTurnId="turn-ambig"
      entries={entries}
      parentThreadBackend="codex"
    />,
  );
  try {
    const items = view.getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-entry-id"))).toEqual([
      "activity-multi-surface",
      "bc-ambig",
    ]);
    expect(within(items[0]!).getByText("Multiple browsers")).toBeInTheDocument();
    expect(within(items[0]!).queryByText("Checked pricing page")).toBeNull();
    expect(within(items[1]!).getByText("Checked pricing page")).toHaveClass("transcript-activity__label");
    expect(items[1]!.querySelector(".transcript-browser-use__meta")).toBeNull();
  } finally {
    view.unmount();
  }
});

it("preserves non-browser work in mixed batches and keeps 1-step browser cards intact inside expanded work groups", () => {
  const entries: AppServerThreadEntry[] = [
    {
      type: "activity",
      id: "activity-mixed",
      summary: "Ran 1 command · Browsed localhost:3000",
      status: "completed",
      turn: { id: "turn-mixed", status: "completed" },
      details: [
        {
          id: "cmd-dev",
          kind: "command",
          label: "pnpm dev",
          status: "completed",
          command: { displayCommand: "pnpm dev", rawCommand: "pnpm dev" },
        },
        {
          id: "call-preview",
          kind: "command",
          label: "In-app browser · localhost:3000/preview",
          status: "completed",
          command: { displayCommand: "node_repl/js", rawCommand: "node_repl/js", source: "tool" },
          browserUse: {
            backend: "iab",
            browserId: "iab",
            url: "http://localhost:3000/preview",
          },
        },
      ],
    },
    {
      type: "message",
      id: "bc-mixed",
      role: "assistant",
      phase: "commentary",
      text: '::browser-complete{title="Verified preview"}',
      turn: { id: "turn-mixed", status: "completed" },
    },
    {
      type: "message",
      id: "final-mixed",
      role: "assistant",
      phase: "final",
      text: "Preview looks good.",
      turn: { id: "turn-mixed", status: "completed" },
    },
  ];

  const view = render(
    <TranscriptList {...listProps} entries={entries} parentThreadBackend="codex" />,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Previous work" }));
    expect(view.getByText("Ran 1 command · Verified preview")).toHaveClass("transcript-activity__label");
    expect(view.getByText("In-app browser")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "localhost:3000/preview" })).toBeInTheDocument();
    expect(view.queryByText(/::browser-complete/)).toBeNull();
  } finally {
    view.unmount();
  }
});

it("keeps browser context visible on deferred detailsRef activities and loads full details on expand", async () => {
  const fullEntry: AppServerThreadActivityEntry = {
    type: "activity",
    id: "activity-deferred-browser",
    summary: "Browsed localhost:3000",
    status: "completed",
    turn: { id: "turn-deferred", status: "completed" },
    details: [
      {
        id: "call-deferred",
        kind: "command",
        label: "Inspect checkout form",
        status: "completed",
        command: {
          displayCommand: 'node_repl/js\n{"title":"Inspect checkout form"}',
          rawCommand: "node_repl/js",
          source: "tool",
          output: "All checkout fields verified",
        },
        browserUse: {
          backend: "iab",
          browserId: "iab",
          url: "http://localhost:3000/checkout",
        },
      },
    ],
  };

  const readThread = vi.fn().mockResolvedValue({
    replay: { entries: [fullEntry], messages: [] },
  });
  const deferredEntry: AppServerThreadActivityEntry = {
    ...fullEntry,
    detailsRef: {
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-deferred",
      entryId: fullEntry.id,
      revision: "rev-1",
    },
    details: [
      {
        ...fullEntry.details[0]!,
        command: { displayCommand: "", source: "tool" },
      },
    ],
  };

  const view = render(
    <TranscriptList
      {...listProps}
      activeTurnId="other-turn"
      desktopApi={{ readThread } as never}
      entries={[
        deferredEntry,
        {
          type: "message",
          id: "bc-deferred",
          role: "assistant",
          phase: "commentary",
          text: '::browser-complete{title="Verified checkout form"}',
          turn: { id: "turn-deferred", status: "completed" },
        },
        {
          type: "message",
          id: "final-deferred",
          role: "assistant",
          phase: "final",
          text: "Checkout form verified.",
          turn: { id: "turn-deferred", status: "completed" },
        },
      ]}
      parentThreadBackend="codex"
    />,
  );
  try {
    fireEvent.click(view.getByRole("button", { name: "Previous work" }));
    expect(view.getByText("Verified checkout form")).toHaveClass("transcript-activity__label");
    expect(view.getByText("In-app browser")).toBeInTheDocument();
    expect(view.getByRole("link", { name: "localhost:3000/checkout" })).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "Verified checkout form" }));
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(view.getByText("Inspect checkout form")).toBeInTheDocument();
    });
  } finally {
    view.unmount();
  }
});
