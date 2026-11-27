import { record } from "./scaling-audit-results";
import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
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

it.each([4,8,16])("resizes %i open bodies",openCount=>{
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

    const observers=SharedTestResizeObserver.instances.length;
    const scroller=view.container.querySelector(".transcript-list__items");
    styleWrites=0;
    for(const width of [600,700,800,900]){
      act(()=>{for(const obs of SharedTestResizeObserver.instances)obs.deliver([{target:scroller,inlineSize:width,blockSize:480}]);});
    }
    expect(view.getByTestId("body-0").style.getPropertyValue(TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY)).toBe("480px");
    record({kind:"resize",n:openCount,observers,styleWrites});
    }finally{view.unmount();heightSpy.mockRestore();styleSpy.mockRestore();}
  });
