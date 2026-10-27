import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Options } from "react-markdown";

const standardRenders = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  return {
    ...actual,
    default: (props: Options) => {
      standardRenders();
      return <actual.default {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.doUnmock("../IncrementalMarkdown");
  vi.clearAllMocks();
});

async function setup() {
  vi.resetModules();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const incrementalRenders = vi.fn();
  vi.doMock("../IncrementalMarkdown", async (importOriginal) => {
    await pending;
    const actual = await importOriginal<typeof import("../IncrementalMarkdown")>();
    return {
      IncrementalMarkdown: (props: Parameters<typeof actual.IncrementalMarkdown>[0]) => {
        incrementalRenders();
        return <actual.IncrementalMarkdown {...props} />;
      },
    };
  });
  const { MarkdownRenderingOptionsProvider: Provider, useIncrementalMarkdownRenderer } =
    await import("../../../lib/markdown-rendering-options");
  const { ThreadMarkdown } = await import("../ThreadMarkdown");
  function Readiness() {
    return <output>{useIncrementalMarkdownRenderer() ? "ready" : "loading"}</output>;
  }
  function Document({ text, enabled = true, revision = 0 }: {
    text: string;
    enabled?: boolean;
    revision?: number;
  }) {
    return <StrictMode><Provider mathEnabled={false} incrementalEnabled={enabled}>
      <Readiness />
      <ThreadMarkdown text={text} className={`revision-${revision}`} />
    </Provider></StrictMode>;
  }
  return {
    Document,
    incrementalRenders,
    load: async () => {
      await act(async () => { finish(); await pending; });
      await waitFor(() => expect(document.querySelector("output")).toHaveTextContent("ready"));
    },
  };
}

it("keeps settled DOM, selection and parse count unchanged when the chunk arrives", async () => {
  const { Document, incrementalRenders, load } = await setup();
  const view = render(<Document text="# Selected heading" />);
  const heading = view.container.querySelector("h1")!;
  const range = document.createRange();
  range.selectNodeContents(heading);
  const selection = window.getSelection()!;
  selection.addRange(range);
  const parses = standardRenders.mock.calls.length;

  await load();
  view.rerender(<Document text="# Selected heading" revision={1} />);
  expect(view.container.querySelector("h1")).toBe(heading);
  expect(heading.isConnected).toBe(true);
  expect(selection.anchorNode).toBe(heading);
  expect(selection.toString()).toBe("Selected heading");
  expect(standardRenders).toHaveBeenCalledTimes(parses);
  expect(incrementalRenders).not.toHaveBeenCalled();
});

it.each([
  "# Heading\n\nStreaming append.\n\n",
  "# Replacement\n\n",
  "# H\n\n",
])("adopts the loaded renderer on the next text change: %s", async (nextText) => {
  const { Document, incrementalRenders, load } = await setup();
  const view = render(<Document text="# Initial" />);
  // Updates while the chunk is pending must still use the standard renderer.
  view.rerender(<Document text="# Heading\n\n" />);
  const standardHeading = view.container.querySelector("h1")!;
  await load();
  expect(incrementalRenders).not.toHaveBeenCalled();
  const standardParses = standardRenders.mock.calls.length;
  view.rerender(<Document text={nextText} />);
  expect(incrementalRenders).toHaveBeenCalled();
  expect(standardHeading.isConnected).toBe(false);
  expect(standardRenders).toHaveBeenCalledTimes(standardParses);
  const incrementalHeading = view.container.querySelector("h1");
  view.rerender(<Document text={`${nextText}\n\nAnother paragraph.\n\n`} />);
  expect(view.container.querySelector("h1")).toBe(incrementalHeading);
});

it("defers cached enable for settled documents, uses it on mount, and disables immediately", async () => {
  const { Document, incrementalRenders, load } = await setup();
  // Warm the chunk without changing the settled document's renderer.
  const warmup = render(<Document text="Warmup" />);
  await load();
  warmup.unmount();

  const view = render(<Document text="# Settled" enabled={false} />);
  const standardHeading = view.container.querySelector("h1")!;
  view.rerender(<Document text="# Settled" />);
  expect(view.container.querySelector("h1")).toBe(standardHeading);
  expect(incrementalRenders).not.toHaveBeenCalled();

  const mounted = render(<Document text="# Newly mounted" />);
  expect(incrementalRenders).toHaveBeenCalled();
  mounted.unmount();
  view.rerender(<Document text="# Settled\n\nNew text." />);
  const incrementalHeading = view.container.querySelector("h1")!;
  expect(standardHeading.isConnected).toBe(false);

  view.rerender(<Document text="# Settled\n\nNew text." enabled={false} />);
  expect(incrementalHeading.isConnected).toBe(false);
  const disabledHeading = view.container.querySelector("h1");
  const renders = incrementalRenders.mock.calls.length;
  view.rerender(<Document text="# Settled\n\nNew text." />);
  expect(view.container.querySelector("h1")).toBe(disabledHeading);
  expect(incrementalRenders).toHaveBeenCalledTimes(renders);
});
