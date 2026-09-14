/**
 * Watch what a `memo`-wrapped component is asked to render.
 *
 * A render-cost test cannot count a memoized component from the outside: the
 * whole point of the boundary is that React stops calling through it, so a
 * wrapper placed *around* the export would be compared and bailed out on
 * instead of the real one. Swapping the function *inside* the memo object
 * leaves the boundary itself untouched, so the bail-out under test still
 * happens and the observer sees exactly the renders React actually performed.
 *
 * **Why this is a helper and not four copies.** The swap is silent when the
 * target is not a memo: `.type` lands on a plain function React never reads,
 * the observer never fires, and every assertion of the form "it did not
 * re-render" passes for the wrong reason — which is the one regression these
 * tests exist to catch. Hand-rolled copies of this harness have forgotten the
 * check more often than they have remembered it, so it lives here where it
 * cannot be forgotten.
 */

const REACT_MEMO = Symbol.for("react.memo");

/**
 * The runtime shape of `memo(Component)`: an object, not a callable. React's
 * types declare it as callable so `ComponentType` accepts it, which is why
 * reaching `.type` needs a cast at every call site.
 */
type MemoExotic = {
  $$typeof?: symbol;
  type: (props: never) => unknown;
};

export type MemoRenderObserver<Props> = {
  /** Install the observer. Call from `beforeEach`. */
  install: (observe: (props: Props) => void) => void;
  /** Put the real function back. Call from `afterEach`. */
  restore: () => void;
};

/**
 * @param component The memoized component, e.g. `ThreadRow`.
 * @param name How to name it if the memo is missing.
 */
export function memoRenderObserver<Props>(
  component: unknown,
  name: string,
): MemoRenderObserver<Props> {
  const memoized = component as MemoExotic;
  const inner = memoized.type;

  return {
    install(observe: (props: Props) => void): void {
      if (memoized.$$typeof !== REACT_MEMO) {
        throw new Error(
          `${name} is not wrapped in React.memo, so this test observes nothing:`
          + " React renders the component itself and never reads `.type`."
          + " Re-add the memo, or stop asserting on its render count.",
        );
      }
      memoized.type = (props: never) => {
        observe(props as Props);
        return inner(props);
      };
    },
    restore(): void {
      memoized.type = inner;
    },
  };
}
