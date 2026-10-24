import {
  createContext,
  useEffect,
  useContext,
  useState,
  useMemo,
  type ReactNode,
} from "react";
import type { MarkdownMathRuntime } from "./markdown-math-runtime";
import { hasPotentialMarkdownMath } from "./markdown-math-detection";

const MarkdownMathEnabledContext = createContext(false);
type IncrementalRenderer = typeof import("../features/thread-detail/IncrementalMarkdown")["IncrementalMarkdown"];
const IncrementalMarkdownContext = createContext<IncrementalRenderer | undefined>(undefined);
let loadedIncrementalRenderer: IncrementalRenderer | undefined;
let incrementalRendererPromise: Promise<IncrementalRenderer | undefined> | undefined;

function loadIncrementalRenderer(): Promise<IncrementalRenderer | undefined> {
  if (!incrementalRendererPromise) {
    incrementalRendererPromise = import("../features/thread-detail/IncrementalMarkdown")
      .then(({ IncrementalMarkdown }) => {
        loadedIncrementalRenderer = IncrementalMarkdown;
        return IncrementalMarkdown;
      })
      .catch((error: unknown) => {
        console.error("Failed to load incremental Markdown rendering", error);
        return undefined;
      });
  }
  return incrementalRendererPromise;
}

export function useIncrementalMarkdownRenderer(): IncrementalRenderer | undefined {
  return useContext(IncrementalMarkdownContext);
}
let loadedMarkdownMathRuntime: MarkdownMathRuntime | undefined;
let markdownMathRuntimePromise: Promise<MarkdownMathRuntime | undefined> | undefined;

function loadMarkdownMathRuntime(): Promise<MarkdownMathRuntime | undefined> {
  if (loadedMarkdownMathRuntime) {
    return Promise.resolve(loadedMarkdownMathRuntime);
  }
  if (!markdownMathRuntimePromise) {
    markdownMathRuntimePromise = import("./markdown-math-runtime")
      .then(({ markdownMathRuntime }) => {
        loadedMarkdownMathRuntime = markdownMathRuntime;
        return markdownMathRuntime;
      })
      .catch((error: unknown) => {
        // Keep the settled promise after failure: streaming, remounts, and
        // setting changes must not retry a broken import indefinitely.
        console.error("Failed to load Markdown math rendering", error);
        return undefined;
      });
  }
  return markdownMathRuntimePromise;
}

export function MarkdownRenderingOptionsProvider(props: {
  children: ReactNode;
  mathEnabled: boolean;
  incrementalEnabled?: boolean;
}) {
  const [incrementalRenderer, setIncrementalRenderer] = useState<IncrementalRenderer | undefined>(
    () => loadedIncrementalRenderer,
  );
  useEffect(() => {
    if (!props.incrementalEnabled || incrementalRenderer) return;
    let active = true;
    void loadIncrementalRenderer().then((renderer) => {
      if (active && renderer) setIncrementalRenderer(() => renderer);
    });
    return () => { active = false; };
  }, [props.incrementalEnabled, incrementalRenderer]);
  return (
    <MarkdownMathEnabledContext.Provider value={props.mathEnabled}>
      <IncrementalMarkdownContext.Provider value={props.incrementalEnabled ? incrementalRenderer : undefined}>
        {props.children}
      </IncrementalMarkdownContext.Provider>
    </MarkdownMathEnabledContext.Provider>
  );
}

export function useMarkdownMathRuntime(markdown: string): MarkdownMathRuntime | undefined {
  const mathEnabled = useContext(MarkdownMathEnabledContext);
  const needsMath = useMemo(
    () => mathEnabled && hasPotentialMarkdownMath(markdown),
    [mathEnabled, markdown],
  );
  const [mathRuntime, setMathRuntime] = useState<MarkdownMathRuntime | undefined>(
    loadedMarkdownMathRuntime,
  );
  useEffect(() => {
    if (!needsMath || mathRuntime) {
      return;
    }
    let active = true;
    void loadMarkdownMathRuntime().then((runtime) => {
      if (active && runtime) {
        setMathRuntime(runtime);
      }
    });
    return () => {
      active = false;
    };
  }, [mathRuntime, needsMath]);

  // Gate even a cached runtime per message. Loading another message must not
  // enable normalization/plugins here or broadcast a context update.
  return needsMath ? mathRuntime : undefined;
}
