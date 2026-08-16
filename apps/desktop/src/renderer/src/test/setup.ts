import { afterEach } from "vitest";

const originalConsoleError = console.error.bind(console);

afterEach(() => {
  // Renderer windows keep reload-only state in sessionStorage. Vitest reuses
  // one jsdom window across files in a worker, so clear that window-scoped
  // state at the test boundary just as closing a real BrowserWindow would.
  window.sessionStorage.clear();
});

console.error = (...args: unknown[]) => {
  // The renderer suite asserts the visible states around these async paths.
  // React's CI-only act warning flood makes GitHub logs unreadable without
  // adding signal for these tests, so keep other errors intact and filter only
  // that exact warning text.
  if (isReactActWarning(args)) {
    return;
  }

  originalConsoleError(...args);
};

function isReactActWarning(args: unknown[]): boolean {
  const [first] = args;
  return (
    typeof first === "string" &&
    first.includes("inside a test was not wrapped in act(...)")
  );
}
