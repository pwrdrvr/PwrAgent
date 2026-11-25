import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendModelOption, BackendSummary } from "@pwragent/shared/contracts/backend";
import type { ThreadTodo } from "@pwragent/shared/contracts/thread-todos";
import { ThreadTodoCard } from "../ThreadTodoCard";
import { TodoDispatchProvider } from "../TodoDispatchProvider";
import {
  codexCatalogModels,
  codexCatalogWithChoiceArbitrary,
  expectModelDropdownToList,
  expectedModelDropdown,
} from "../../../test/model-catalog";

type CatalogCase = readonly [BackendModelOption[], BackendModelOption];
let activeProperty: Promise<void> | undefined;
async function retireCatalogModels(): Promise<void> {
  // Vitest owns the assertion failure. This hook joins its work before the
  // next test can mount roots that global cleanup would otherwise remove.
  await activeProperty?.catch(() => {});
  activeProperty = undefined;
  cleanup();
}
afterEach(retireCatalogModels);
async function runCatalogCase(signal: AbortSignal, [models, choice]: CatalogCase, afterOpen?: () => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const todo: ThreadTodo = {
    id: "card", backend: "codex", threadId: "thread-a", kind: "handoff", status: "open",
    title: "Cache the signing-key lookup", createdAt: 0, updatedAt: 0,
    action: { type: "start_thread", prompt: "Cache the key", workMode: "worktree" },
    dispatchDefaults: { thread: { backend: "codex", model: choice.id } },
  };
  const backends = [{
    kind: "codex", label: "Codex", available: true, capabilities: { createThread: true },
    launchpadOptions: { models },
  }] as BackendSummary[];
  const api = { listModelSettingsRecents: vi.fn(async () => ({ recents: [] })) };
  const mounted = render(
    <TodoDispatchProvider api={api} backends={backends} todos={[todo]}>
      <ThreadTodoCard todo={todo} running={false} now={0} onRun={vi.fn()} onResolve={vi.fn()}
        onStartReview={vi.fn()} onSetItemChecked={vi.fn()} />
    </TodoDispatchProvider>,
  );
  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Model for the new thread:/ }));
    });
    if (afterOpen) await afterOpen();
    signal.throwIfAborted();
    fireEvent.click(screen.getByRole("menuitem", { name: /^To-do model:/ }));
    const list = screen.getByRole("listbox", { name: /^To-do model/ });
    // The Provider picker chooses the Codex provider, so the Model menu
    // lists that provider's models by the shared rule.
    expectModelDropdownToList(list, "To-do model", expectedModelDropdown({
      kind: "codex",
      models,
      thread: { model: choice.id },
      opensDown: true,
    }));
  } finally {
    mounted.unmount();
    mounted.container.remove();
  }
}

/**
 * The rule the to-do picker broke before it shared the composer's: a model
 * picker lists any catalog the way `buildModelMenu` arranges it.
 */
describe("to-do dispatch model picker properties", () => {
  it("lists any Codex catalog by the shared model menu rule", async ({ signal }) => {
    await (activeProperty = fc.assert(fc.asyncProperty(codexCatalogWithChoiceArbitrary,
      catalog => runCatalogCase(signal, catalog)), { numRuns: 20 }));
  });
});

function fixtureModels(): CatalogCase {
  const models = codexCatalogModels();
  return [models, models[0]!];
}

function menuGate() {
  let release!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>(resolve => { opened = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  return {
    ready,
    release,
    afterOpen: async () => {
      expect(screen.getByRole("menuitem", { name: /^To-do model:/ })).toBeTruthy();
      opened();
      await hold;
    },
  };
}

it("an aborted menu case leaves another render root intact", async () => {
  const aborted = new AbortController();
  const reason = new Error("controlled abort at menu readiness");
  const gate = menuGate();
  const work = runCatalogCase(aborted.signal, fixtureModels(), gate.afterOpen).then(() => undefined, error => error);
  await gate.ready;
  const other = render(<div>Independent owner</div>);
  try {
    aborted.abort(reason);
    gate.release();
    const error = await work;
    expect([error, other.container.isConnected, other.container.textContent]).toEqual([reason, true, "Independent owner"]);
  } finally {
    gate.release();
    await work;
    other.unmount();
    other.container.remove();
  }
});

it("teardown joins the admitted case before global DOM cleanup", async () => {
  const gate = menuGate();
  const work = activeProperty = runCatalogCase(new AbortController().signal, fixtureModels(), gate.afterOpen);
  const outcome = work.then(() => undefined, error => error);
  await gate.ready;
  const retiring = retireCatalogModels();
  try {
    expect(screen.queryByRole("menuitem", { name: /^To-do model:/ })).not.toBeNull();
  } finally {
    gate.release();
    await outcome;
    await retiring;
  }
  expect(await outcome).toBeUndefined();
});

it("starts no catalog case after abort", async () => {
  const reason = new Error("already retired model owner");
  await expect(runCatalogCase(AbortSignal.abort(reason), fixtureModels())).rejects.toBe(reason);
});
