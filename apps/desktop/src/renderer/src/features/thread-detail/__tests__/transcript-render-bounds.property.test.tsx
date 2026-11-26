import { act, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { TranscriptList } from "../TranscriptList";
import * as WorkPhaseGroupModule from "../TranscriptWorkPhaseGroup";
import { setSidebarResizing } from "../../../lib/sidebar-resize-signal";
import {
  TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY,
  useTranscriptScrollportHeight,
} from "../transcript-scroll-fit";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class SharedTestResizeObserver implements ResizeObserver {
  static instances: SharedTestResizeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    SharedTestResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }

  deliver(
    entries: Array<{
      target: Element;
      inlineSize: number;
      blockSize: number;
      contentBlockSize?: number;
    }>,
  ): void {
    const matched = entries
      .filter((item) => this.targets.has(item.target))
      .map((item) => {
        const borderSize = [{ inlineSize: item.inlineSize, blockSize: item.blockSize }];
        const contentSize = [
          {
            inlineSize: item.inlineSize,
            blockSize: item.contentBlockSize ?? item.blockSize,
          },
        ];
        return {
          target: item.target,
          contentRect: new DOMRect(0, 0, item.inlineSize, item.contentBlockSize ?? item.blockSize),
          borderBoxSize: borderSize,
          contentBoxSize: contentSize,
          devicePixelContentBoxSize: borderSize,
        } as unknown as ResizeObserverEntry;
      });
    if (matched.length > 0) {
      this.callback(matched, this);
    }
  }
}

function FittedBody({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useTranscriptScrollportHeight(ref, true);
  return <div ref={ref} data-testid={`body-${id}`} />;
}

describe("transcript render and scrollport bounds", () => {
  it("shares one ResizeObserver per scroller across K open bodies and skips unchanged-height writes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 400, max: 1100 }), { minLength: 2, maxLength: 5 }),
        (openCount, widths) => {
          SharedTestResizeObserver.instances = [];
          vi.stubGlobal("ResizeObserver", SharedTestResizeObserver);
          let clientHeight = 480;
          const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
          const heightSpy = vi
            .spyOn(Element.prototype, "clientHeight", "get")
            .mockImplementation(function (this: Element) {
              if (this.classList.contains("transcript-list__items")) return clientHeight;
              return origClientHeight.call(this) as number;
            });

          let styleWrites = 0;
          const origSetProperty = CSSStyleDeclaration.prototype.setProperty;
          const styleSpy = vi
            .spyOn(CSSStyleDeclaration.prototype, "setProperty")
            .mockImplementation(function (this: CSSStyleDeclaration, prop, val, priority) {
              if (prop === TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY) styleWrites += 1;
              return origSetProperty.call(this, prop, val, priority);
            });

          const view = render(
            <div className="transcript-list__items">
              {Array.from({ length: openCount }, (_, i) => (
                <FittedBody key={i} id={String(i)} />
              ))}
            </div>,
          );
          try {
            // Exactly 1 ResizeObserver regardless of how many diffs/outputs are open.
            expect(SharedTestResizeObserver.instances.length).toBe(1);
            expect(styleWrites).toBe(openCount);

            const scroller = view.container.querySelector<HTMLElement>(".transcript-list__items")!;
            // Model `.transcript-list__items` vertical padding (22px -> 16px when
            // pending item toggles): borderBoxSize matches clientHeight while
            // contentBoxSize shifts by 6px. Neither initial delivery, padding
            // toggle, nor width-only resizes may write `--transcript-scrollport-height`.
            styleWrites = 0;
            act(() => {
              SharedTestResizeObserver.instances[0]!.deliver([
                { target: scroller, inlineSize: widths[0]!, blockSize: clientHeight, contentBlockSize: clientHeight - 22 },
              ]);
            });
            act(() => {
              SharedTestResizeObserver.instances[0]!.deliver([
                { target: scroller, inlineSize: widths[0]!, blockSize: clientHeight, contentBlockSize: clientHeight - 16 },
              ]);
            });
            for (const width of widths) {
              act(() => {
                SharedTestResizeObserver.instances[0]!.deliver([
                  { target: scroller, inlineSize: width, blockSize: clientHeight, contentBlockSize: clientHeight - 22 },
                ]);
              });
            }
            expect(styleWrites).toBe(0);
            expect(
              view
                .getByTestId("body-0")
                .style.getPropertyValue(TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY),
            ).toBe("480px");

            // A genuine height change writes once per open body.
            clientHeight = 620;
            act(() => {
              SharedTestResizeObserver.instances[0]!.deliver([
                { target: scroller, inlineSize: widths[0]!, blockSize: clientHeight, contentBlockSize: clientHeight - 22 },
              ]);
            });
            expect(styleWrites).toBe(openCount);
            expect(
              view
                .getByTestId("body-0")
                .style.getPropertyValue(TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY),
            ).toBe("620px");
          } finally {
            view.unmount();
            expect(SharedTestResizeObserver.instances[0]!.disconnected).toBe(true);
            heightSpy.mockRestore();
            styleSpy.mockRestore();
          }
        },
      ),
      { numRuns: 5, examples: [[4, [700, 900, 1040]]] },
    );
  });

  it("does not re-render completed TranscriptWorkPhaseGroups while streaming chunks arrive", () => {
    const completedEntries: AppServerThreadEntry[] = [
      {
        id: "user-1",
        type: "message",
        role: "user",
        text: "Check layout bounds",
      },
      {
        id: "commentary-1",
        type: "message",
        role: "assistant",
        phase: "commentary",
        text: "Inspecting layout observers",
        turn: { id: "turn-1", status: "completed", durationMs: 4_000 },
      },
      {
        id: "activity-1",
        type: "activity",
        summary: "Edited 1 file",
        details: [
          {
            id: "detail-1",
            kind: "write",
            label: "Updated dock.ts",
            path: "src/dock.ts",
            status: "completed",
          },
        ],
        turn: { id: "turn-1", status: "completed", durationMs: 4_000 },
      },
      {
        id: "final-1",
        type: "message",
        role: "assistant",
        phase: "final",
        text: "First pass done.",
        turn: { id: "turn-1", status: "completed", durationMs: 4_000 },
      },
    ];

    let groupRenders = 0;
    const memoGroup = WorkPhaseGroupModule.TranscriptWorkPhaseGroup as unknown as {
      type: (...args: unknown[]) => unknown;
    };
    const origType = memoGroup.type;
    vi.spyOn(memoGroup, "type").mockImplementation(function (this: unknown, ...args: unknown[]) {
      groupRenders += 1;
      return origType.apply(this, args);
    });

    const renderWithStreamText = (text: string) => (
      <TranscriptList
        threadId="thread-stream-memo"
        entries={[
          ...completedEntries,
          {
            id: "streaming-msg",
            type: "message",
            role: "assistant",
            text,
            turn: { id: "turn-2", status: "in_progress" },
          },
        ]}
        loading={false}
        loadingMore={false}
        onLoadOlder={async () => {}}
      />
    );

    const view = render(renderWithStreamText("Chunk 0"));
    try {
      const toggle = view.container.querySelector<HTMLButtonElement>(
        ".transcript-work-phase-group__toggle",
      )!;
      expect(toggle).not.toBeNull();
      // Toggle works with stabilized callback.
      act(() => {
        fireEvent.click(toggle);
      });
      expect(toggle.getAttribute("aria-expanded")).toBe("true");

      // Stream 6 chunks into the trailing message: completed group renders 0 times.
      groupRenders = 0;
      for (let i = 1; i <= 6; i += 1) {
        act(() => view.rerender(renderWithStreamText(`Chunk ${i}`)));
      }
      expect(groupRenders).toBe(0);
    } finally {
      view.unmount();
    }
  });

  it("ignores width-only ResizeObserver deliveries on TranscriptList", () => {
    SharedTestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", SharedTestResizeObserver);
    let scrollHeight = 800;
    const clientHeight = 480;
    let scrollHeightReads = 0;
    let rafSchedules = 0;
    const origScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      if (this.classList.contains("transcript-list__items")) {
        scrollHeightReads += 1;
        return scrollHeight;
      }
      return origScrollHeight.call(this) as number;
    });
    const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
      if (this.classList.contains("transcript-list__items")) {
        return clientHeight;
      }
      return origClientHeight.call(this) as number;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
      rafSchedules += 1;
      return rafSchedules;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});

    const view = render(
      <TranscriptList
        threadId="thread-resize-filter"
        entries={[
          { id: "m1", type: "message", role: "assistant", text: "Stable content" },
        ]}
        loading={false}
        loadingMore={false}
        onLoadOlder={async () => {}}
      />,
    );
    try {
      const container = view.container.querySelector<HTMLElement>(".transcript-list__items")!;
      const content = container.firstElementChild as HTMLElement;
      rafSchedules = 0;

      // Initial delivery with unchanged scrollHeight/clientHeight does not schedule scrollToBottom.
      act(() => {
        for (const obs of SharedTestResizeObserver.instances) {
          obs.deliver([
            { target: container, inlineSize: 800, blockSize: 480 },
            { target: content, inlineSize: 800, blockSize: 800 },
          ]);
        }
      });
      expect(rafSchedules).toBe(0);

      // Width-only resizes with unchanged blockSize trigger 0 scrollHeight reads and 0 rAFs.
      scrollHeightReads = 0;
      rafSchedules = 0;
      for (const width of [720, 960, 840]) {
        act(() => {
          for (const obs of SharedTestResizeObserver.instances) {
            obs.deliver([
              { target: container, inlineSize: width, blockSize: 480 },
              { target: content, inlineSize: width, blockSize: 800 },
            ]);
          }
        });
      }
      expect(scrollHeightReads).toBe(0);
      expect(rafSchedules).toBe(0);

      // Sidebar drag changes content height to 1000px while resizing is active,
      // then ends, then a later non-drag resize returns content height to 800px:
      // must NOT be dropped as stale.
      setSidebarResizing(true);
      scrollHeight = 1000;
      act(() => {
        for (const obs of SharedTestResizeObserver.instances) {
          obs.deliver([
            { target: container, inlineSize: 640, blockSize: 480 },
            { target: content, inlineSize: 640, blockSize: 1000 },
          ]);
        }
      });
      act(() => {
        setSidebarResizing(false);
      });
      rafSchedules = 0;
      scrollHeight = 800;
      act(() => {
        for (const obs of SharedTestResizeObserver.instances) {
          obs.deliver([
            { target: container, inlineSize: 800, blockSize: 480 },
            { target: content, inlineSize: 800, blockSize: 800 },
          ]);
        }
      });
      expect(rafSchedules).toBeGreaterThan(0);
    } finally {
      act(() => {
        setSidebarResizing(false);
      });
      view.unmount();
    }
  });

  it("syncs when content height changes between mount layout effect and first ResizeObserver tick", () => {
    SharedTestResizeObserver.instances = [];
    vi.stubGlobal("ResizeObserver", SharedTestResizeObserver);
    let scrollHeight = 500;
    const origScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight")!.get!;
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
      if (this.classList.contains("transcript-list__items")) return scrollHeight;
      return origScrollHeight.call(this) as number;
    });
    const origClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!.get!;
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
      if (this.classList.contains("transcript-list__items")) return 400;
      return origClientHeight.call(this) as number;
    });

    const view = render(
      <TranscriptList
        threadId="thread-pre-first-tick"
        entries={[
          { id: "m1", type: "message", role: "assistant", text: "Late font/image growth" },
        ]}
        loading={false}
        loadingMore={false}
        onLoadOlder={async () => {}}
      />,
    );
    try {
      const container = view.container.querySelector<HTMLElement>(".transcript-list__items")!;
      const content = container.firstElementChild as HTMLElement;
      expect(container.scrollTop).toBe(500);

      // Height grows before the first ResizeObserver callback arrives.
      scrollHeight = 920;
      act(() => {
        for (const obs of SharedTestResizeObserver.instances) {
          obs.deliver([
            { target: container, inlineSize: 800, blockSize: 400 },
            { target: content, inlineSize: 800, blockSize: 920 },
          ]);
        }
      });
      expect(container.scrollTop).toBe(920);
    } finally {
      view.unmount();
    }
  });
});
