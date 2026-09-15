import { memo, StrictMode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MarkdownMathRuntime } from "../markdown-math-runtime";

// Reset only the options module between tests; keep React's identity stable.
afterEach(() => {
  cleanup();
  vi.doUnmock("../markdown-math-runtime");
  vi.restoreAllMocks();
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
