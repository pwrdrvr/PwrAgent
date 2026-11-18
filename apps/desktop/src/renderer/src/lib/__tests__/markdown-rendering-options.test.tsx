import { memo, StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownMathRuntime } from "../markdown-math-runtime";

// Reset only the options module between tests; keep React's identity stable.
afterEach(() => {
  cleanup();
  vi.doUnmock("../markdown-math-runtime");
  vi.doUnmock("../../features/thread-detail/IncrementalMarkdown");
  vi.restoreAllMocks();
});

async function setupIncremental() {
  vi.resetModules();
  type Renderer = typeof import("../../features/thread-detail/IncrementalMarkdown")["IncrementalMarkdown"];
  const renderer: Renderer = () => [];
  let resolve!: (value: { IncrementalMarkdown: Renderer }) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ IncrementalMarkdown: Renderer }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const load = vi.fn(() => pending);
  vi.doMock("../../features/thread-detail/IncrementalMarkdown", load);
  const { MarkdownRenderingOptionsProvider: Provider, useIncrementalMarkdownRenderer } =
    await import("../markdown-rendering-options");
  function Message() {
    return useIncrementalMarkdownRenderer() ? "incremental" : "standard";
  }
  return { Provider, Message, load,
    finish: () => act(async () => { resolve({ IncrementalMarkdown: renderer }); await pending; }),
    fail: () => act(async () => { reject(new Error("Import failed")); await pending.catch(() => {}); }),
  };
}

describe("incremental Markdown loading", () => {
  it("keeps the default and explicit opt-out on the standard renderer without loading", async () => {
    const { Provider, Message, load } = await setupIncremental();
    const view = render(<Provider mathEnabled={false}><Message /></Provider>);
    expect(view.container.textContent).toBe("standard");
    view.rerender(<Provider mathEnabled={false} incrementalEnabled={false}><Message /></Provider>);
    expect(load).not.toHaveBeenCalled();
  });

  it("shares one load, falls back while pending, and switches back immediately when disabled", async () => {
    const { Provider, Message, load, finish } = await setupIncremental();
    const view = render(<StrictMode><Provider mathEnabled={false} incrementalEnabled><Message /></Provider></StrictMode>);
    const second = render(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(view.container.textContent).toBe("standard");
    await finish();
    expect(view.container.textContent).toBe("incremental");
    expect(second.container.textContent).toBe("incremental");
    second.rerender(<Provider mathEnabled={false} incrementalEnabled={false}><Message /></Provider>);
    expect(second.container.textContent).toBe("standard");
    second.rerender(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    expect(second.container.textContent).toBe("incremental");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale load after disable or unmount and does not enable a cached runtime by default", async () => {
    const { Provider, Message, finish } = await setupIncremental();
    const view = render(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    const unmounted = render(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    await act(async () => {});
    view.rerender(<Provider mathEnabled={false}><Message /></Provider>);
    unmounted.unmount();
    await finish();
    expect(view.container.textContent).toBe("standard");
    const later = render(<Provider mathEnabled={false}><Message /></Provider>);
    expect(later.container.textContent).toBe("standard");
    view.rerender(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    await act(async () => {});
    expect(view.container.textContent).toBe("incremental");
  });

  it("retains standard rendering after a failed import without a toggle/remount retry loop", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Provider, Message, load, fail } = await setupIncremental();
    const view = render(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    await act(async () => {});
    await fail();
    expect(view.container.textContent).toBe("standard");
    view.rerender(<Provider mathEnabled={false}><Message /></Provider>);
    view.rerender(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    view.unmount();
    render(<Provider mathEnabled={false} incrementalEnabled><Message /></Provider>);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

async function setup() {
  vi.resetModules();
  let resolve!: (value: { markdownMathRuntime: MarkdownMathRuntime }) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<{ markdownMathRuntime: MarkdownMathRuntime }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const load = vi.fn(() => pending);
  vi.doMock("../markdown-math-runtime", load);
  const { MarkdownRenderingOptionsProvider: Provider, useMarkdownMathRuntime } =
    await import("../markdown-rendering-options");
  const normalize = vi.fn((text: string) => text);
  const runtime: MarkdownMathRuntime = { normalize, remarkPlugins: [], rehypePlugins: [] };
  const renders = vi.fn();
  const Message = memo(function Message({ text }: { text: string }) {
    const math = useMarkdownMathRuntime(text);
    renders(text, math);
    return <div>{math ? "math:" : "plain:"}{text}</div>;
  });
  return { Provider, Message, load, renders, runtime,
    finish: () => act(async () => { resolve({ markdownMathRuntime: runtime }); await pending; }),
    fail: () => act(async () => { reject(new Error("offline")); await pending.catch(() => {}); }),
  };
}

describe("per-message math loading", () => {
  it("does not load for an enabled empty provider, ordinary messages or currency", async () => {
    const { Provider, Message, load } = await setup();
    const view = render(<Provider mathEnabled><Message text="A $5 part and **bold**" /></Provider>);
    view.rerender(<Provider mathEnabled><Message text="```ts\nconst x = 1\n```" /></Provider>);
    view.rerender(<Provider mathEnabled>{null}</Provider>);
    expect(load).not.toHaveBeenCalled();
  });

  it("shares one concurrent load and only updates requesting messages", async () => {
    const { Provider, Message, load, renders, runtime, finish } = await setup();
    const view = render(<StrictMode><Provider mathEnabled>
      <Message text="ordinary" /><Message text="$$a$$" /><Message text="$$b$$" />
    </Provider></StrictMode>);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    const ordinaryRenders = renders.mock.calls.filter(([text]) => text === "ordinary").length;
    await finish();
    expect(renders.mock.calls.filter(([text]) => text === "ordinary")).toHaveLength(ordinaryRenders);
    expect(renders).toHaveBeenCalledWith("$$a$$", runtime);
    expect(renders).toHaveBeenCalledWith("$$b$$", runtime);
    view.rerender(<Provider mathEnabled><Message text="new ordinary" /><Message text="$$c$$" /></Provider>);
    expect(renders).toHaveBeenCalledWith("new ordinary", undefined);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("handles delimiters split across updates and source replacement during loading", async () => {
    const { Provider, Message, load, renders, finish } = await setup();
    const view = render(<Provider mathEnabled><Message text="prefix $" /></Provider>);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Provider mathEnabled><Message text="prefix $$" /></Provider>);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Provider mathEnabled><Message text="replacement" /></Provider>);
    const count = renders.mock.calls.length;
    await finish();
    expect(renders).toHaveBeenCalledTimes(count);
    view.rerender(<Provider mathEnabled><Message text={String.raw`prefix \(x\)`} /></Provider>);
    await act(async () => {});
    expect(view.container.textContent).toContain("math:");
    view.rerender(<Provider mathEnabled><Message text="plain again" /></Provider>);
    expect(view.container.textContent).toBe("plain:plain again");
  });

  it("does not load while disabled and ignores completion after disable or unmount", async () => {
    const { Provider, Message, load, renders, finish } = await setup();
    const view = render(<Provider mathEnabled={false}><Message text="$$x$$" /></Provider>);
    expect(load).not.toHaveBeenCalled();
    view.rerender(<Provider mathEnabled><Message text="$$x$$" /></Provider>);
    await act(async () => {});
    view.rerender(<Provider mathEnabled={false}><Message text="$$x$$" /></Provider>);
    const count = renders.mock.calls.length;
    await finish();
    expect(renders).toHaveBeenCalledTimes(count);
    expect(view.container.textContent).toBe("plain:$$x$$");
    view.unmount();
    render(<Provider mathEnabled={false}><Message text="$$cached$$" /></Provider>);
    expect(renders).toHaveBeenLastCalledWith("$$cached$$", undefined);
  });

  it("ignores completion after a requesting message unmounts", async () => {
    const { Provider, Message, renders, finish } = await setup();
    const view = render(<Provider mathEnabled><Message text="$$x$$" /></Provider>);
    await act(async () => {});
    view.unmount();
    const count = renders.mock.calls.length;
    await finish();
    expect(renders).toHaveBeenCalledTimes(count);
    render(<Provider mathEnabled><Message text="$$y$$" /></Provider>);
    expect(renders.mock.calls.at(-1)?.[1]).toBeDefined();
  });

  it("does not retry a failed import on streaming, toggles or remounts", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { Provider, Message, load, fail } = await setup();
    const view = render(<Provider mathEnabled><Message text="$$x" /></Provider>);
    await act(async () => {});
    await fail();
    view.rerender(<Provider mathEnabled><Message text="$$x$$" /></Provider>);
    view.rerender(<Provider mathEnabled={false}><Message text="$$x$$" /></Provider>);
    view.rerender(<Provider mathEnabled><Message text="$$x$$" /></Provider>);
    view.unmount();
    render(<Provider mathEnabled><Message text="$$y$$" /></Provider>);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
