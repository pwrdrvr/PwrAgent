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
}) {
  return (
    <MarkdownMathEnabledContext.Provider value={props.mathEnabled}>
      {props.children}
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
