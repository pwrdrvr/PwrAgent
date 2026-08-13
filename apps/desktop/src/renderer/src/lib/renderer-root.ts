import type { ReactNode } from "react";

/**
 * A mounted React root, narrowed to the one method the entry point uses.
 * Structural rather than `ReactDOM.Root` so this module doesn't pull
 * react-dom in just for a type.
 */
export type RendererRoot = {
  render: (children: ReactNode) => void;
};

/**
 * Where a container's root is parked between evaluations of the entry
 * module.
 *
 * It has to live on the container, not in a module-level variable: Vite's
 * dev server wraps every JSX module in a self-accepting Fast Refresh
 * boundary, `main.tsx` included, and that module can't actually refresh
 * (its exports aren't components). So an HMR update re-executes the whole
 * module body in the live page and only then invalidates. A module-level
 * cache is recreated along with the module and sees nothing. The container
 * outlives every one of those re-evaluations, which makes it the only place
 * the second evaluation can find the root the first one left behind.
 *
 * `Symbol.for` rather than `Symbol()` for the same reason — the module that
 * declares it is itself re-evaluated, so the key must be looked up in the
 * global registry instead of minted fresh.
 */
const ROOT_KEY: unique symbol = Symbol.for("pwragent.rendererRoot");

type RootHost = Element & { [ROOT_KEY]?: RendererRoot };

/**
 * Render `children` into `container`, creating the React root only the
 * first time the container is seen.
 *
 * Calling `createRoot` twice on one container leaves two roots reconciling
 * the same DOM. Each owns nodes the other doesn't know about, so the loser
 * throws `NotFoundError: Failed to execute 'removeChild' on 'Node'` when it
 * tries to clean up. React's own
 * "You are calling ReactDOMClient.createRoot() on a container that has
 * already been passed to createRoot() before" warning is the mild half of
 * that outcome.
 *
 * In a production build this runs exactly once and the lookup is a single
 * miss; the guard exists for the dev HMR path, where it turns a dirty
 * double-mount into a plain re-render.
 */
export function mountRendererRoot(
  container: Element,
  children: ReactNode,
  createRoot: (container: Element) => RendererRoot,
): RendererRoot {
  const host = container as RootHost;
  const root = host[ROOT_KEY] ?? createRoot(container);
  host[ROOT_KEY] = root;
  root.render(children);
  return root;
}
