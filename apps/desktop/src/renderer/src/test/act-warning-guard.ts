import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { RunnerTask, RunnerTaskResultPack } from "vitest";

const KEY = Symbol.for("pwragent.rendererActWarningGuard");

/** Test-only: keep the async creator, even when its callback runs in a later test. */
class ActWarningGuard {
  readonly owners = new AsyncLocalStorage<RunnerTask>();
  private readonly warnings = new Map<RunnerTask, Error[]>();
  private readonly unowned: Error[] = [];
  private installedConsole?: Console;

  install(): void {
    if (globalThis.console === this.installedConsole) return;
    const wrappers = new WeakMap<Console["error"], Console["error"]>();
    // Observe calls outside the mock itself. A spy can silence forwarding or
    // restore the original method without removing the guard. Proxying the
    // function preserves the spy's mock API and the console's receiver/args.
    globalThis.console = new Proxy(globalThis.console, {
      get: (target, key, receiver) => {
        const method = Reflect.get(target, key, receiver);
        if ((key !== "error" && key !== "warn") || typeof method !== "function") {
          return method;
        }
        let wrapped = wrappers.get(method);
        if (!wrapped) {
          const guardedMethod: Console["error"] = new Proxy(method, {
            apply: (delegate, thisArg, args) => {
              this.observe(args);
              return Reflect.apply(delegate, thisArg, args);
            },
          });
          wrapped = guardedMethod;
          wrappers.set(method, guardedMethod);
          // A spy restores the function it read from the proxy. Do not wrap
          // that already guarded function again on the next property read.
          wrappers.set(guardedMethod, guardedMethod);
        }
        return wrapped;
      },
    });
    this.installedConsole = globalThis.console;
  }

  private observe(args: unknown[]): void {
    if (!args.some((arg) => typeof arg === "string" && /\bnot wrapped in act\(\.\.\.\)/.test(arg))) return;
    const message = format(...args);
    const owner = this.owners.getStore();
    const error = new Error([
      `React act warning in ${owner?.name ?? "renderer test collection"}:`,
      message,
      "Await the owned React update inside act, including teardown work.",
    ].join("\n"));
    if (owner) {
      const warnings = this.warnings.get(owner) ?? [];
      warnings.push(error);
      this.warnings.set(owner, warnings);
    } else {
      this.unowned.push(error);
    }
  }

  /** Called after all test hooks, then again after suite teardown for late work. */
  report(fallback: RunnerTask): RunnerTaskResultPack[] {
    if (this.unowned.length > 0) {
      this.warnings.set(fallback, [
        ...(this.warnings.get(fallback) ?? []),
        ...this.unowned.splice(0),
      ]);
    }
    const updates: RunnerTaskResultPack[] = [];
    for (const [task, errors] of this.warnings) {
      task.result ??= { state: "fail" };
      task.result.state = "fail";
      task.result.errors ??= [];
      task.result.errors.push(...errors.map((error) => ({
        name: error.name,
        message: error.message,
        stack: error.stack,
      })));
      updates.push([task.id, task.result, task.meta]);
      // A late failure must also change already completed ancestor suites.
      for (let suite = task.suite; suite; suite = suite.suite) {
        if (suite.result) suite.result.state = "fail";
        updates.push([suite.id, suite.result, suite.meta]);
      }
    }
    this.warnings.clear();
    return updates;
  }
}

type GuardGlobal = typeof globalThis & { [KEY]?: ActWarningGuard };

export function getActWarningGuard(): ActWarningGuard {
  return (globalThis as GuardGlobal)[KEY] ??= new ActWarningGuard();
}
