import {
  createContext,
  useEffect,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { MarkdownMathRuntime } from "./markdown-math-runtime";

const MarkdownMathRuntimeContext = createContext<MarkdownMathRuntime | undefined>(
  undefined,
);
let loadedMarkdownMathRuntime: MarkdownMathRuntime | undefined;
let markdownMathRuntimePromise: Promise<MarkdownMathRuntime> | undefined;

function loadMarkdownMathRuntime(): Promise<MarkdownMathRuntime> {
  if (loadedMarkdownMathRuntime) {
    return Promise.resolve(loadedMarkdownMathRuntime);
  }
  if (!markdownMathRuntimePromise) {
    markdownMathRuntimePromise = import("./markdown-math-runtime")
      .then(({ markdownMathRuntime }) => {
        loadedMarkdownMathRuntime = markdownMathRuntime;
        return markdownMathRuntime;
      })
      .finally(() => {
        markdownMathRuntimePromise = undefined;
      });
  }
  return markdownMathRuntimePromise;
}

export function MarkdownRenderingOptionsProvider(props: {
  children: ReactNode;
  mathEnabled: boolean;
}) {
  const [mathRuntime, setMathRuntime] = useState<MarkdownMathRuntime | undefined>(
    loadedMarkdownMathRuntime,
  );
  useEffect(() => {
    if (!props.mathEnabled || mathRuntime) {
      return;
    }
    let active = true;
    void loadMarkdownMathRuntime()
      .then((runtime) => {
        if (active) {
          setMathRuntime(runtime);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load Markdown math rendering", error);
      });
    return () => {
      active = false;
    };
  }, [mathRuntime, props.mathEnabled]);

  return (
    <MarkdownMathRuntimeContext.Provider
      value={props.mathEnabled ? mathRuntime : undefined}
    >
      {props.children}
    </MarkdownMathRuntimeContext.Provider>
  );
}

export function useMarkdownMathRuntime(): MarkdownMathRuntime | undefined {
  return useContext(MarkdownMathRuntimeContext);
}
