---
name: model-based-bug-hunt
description: Hunt PwrAgent bugs with model-based testing (MBT). Use when fixing or investigating bugs in rule-heavy logic, state machines, caches, concurrency, or state derived from provider events, Git, or an owning instance, or when the operator asks "did we MBT this?" or "find more wiggles".
---

# Model-based bug hunting

Read the [property, model and oracle testing policy](../../../docs/property-model-oracle-testing.md) for what to check in and the CI budget. Follow [repository verification](../../../docs/development-checks.md#verification) and [local CPU checkout](../../../docs/local-cpu-checkout.md).

## From a report to a wider search

1. **Reproduce the reported bug first.** Write the broken promise in one sentence. Build the smallest property that can exercise it and watch it fail on pre-fix code before writing the fix. In #4633, 20 runs over a few kinds of reads exposed a rename lost after a point read and a listing.
2. **Widen through the layer that shows the symptom.** In #4633, events from the real `DesktopBackendRegistry` flowed into the real `LiveNavigationIndex` the sidebar reads. The provider client was a mock. Use the normal entry points so the search exercises real event propagation and cache invalidation. [PR #4633 model test](https://github.com/pwrdrvr/PwrAgent/blob/84e5ea66fe3fdb89da8c9d9a4a878d68b268cb55/apps/desktop/src/main/__tests__/pending-start-title.property.test.ts) · [PR diff with the narrow property](https://github.com/pwrdrvr/PwrAgent/pull/4633/files) · [Navigation index differential model](../../../apps/desktop/src/main/__tests__/live-navigation-index.property.test.ts)
3. **Generate operations the system can produce.** Replay starts, renames, provider echoes, listing updates, failing point reads, lifecycle redeliveries, and reads. Deliberately include possible stale and duplicate events. Use a replay guard such as `continue` for an impossible operation, such as generating a title after an explicit rename. Put provider behavior in the generated input so it survives shrinking. For example, generate whether the listing can lag behind the point read.
4. **Take the oracle from the promise.** Once the owner names a thread, every settled read should show that name. Compare the live index, listing, cache, and thread info as one labeled object so the diff identifies the first layer that diverges. When the design allows a transient gap, loop on the index's own `isCurrent` check with a bounded number of attempts. Use readiness signals or event-loop yields without wall-clock sleeps.
5. **Document permitted outcomes and scope.** Before the first name, allow the placeholders the design permits and explain why in the assertion. A different explicit provider name can win when another process renames the thread. For a property about the local rename, restrict the generator to exclude competing explicit renames and document that scope. Preserve the assertion for every generated case within it.
6. **Search wide locally and keep CI cheap.** Try `MBT_RUNS=200` or `2000` locally. Use about five generated runs by default for a cross-layer model that fits the policy. Pin each shrunk counterexample as a named Vitest test that calls the same replay helper. Comment on what each case caught and keep the named tests even when the generated property stays local. Reserve the property's `numRuns` for generated cases.
7. **Verify each pinned case against broken code.** In a scratch checkout with the fix committed, save the exact fixed source, then load the pre-fix source from `git show <base>:<path>` (write it to a temporary file first), or remove one fix at a time. Confirm that the mutation changed the source with `git diff --stat -- <path>`. Run each named case in isolation and verify the expected assertion fails. Restore the source and verify it with `cmp`, then confirm the cases pass.
8. **Report the evidence.** List the pinned cases, the broken variants that each case caught, and the post-fix results. In the PR, identify modeled provider behavior that lacks a protocol capture. #4633 observed the sidebar symptom and modeled listing lag. Use a capture to answer questions about actual wire behavior. [Desktop capture rules](../../../apps/desktop/AGENTS.md#capturing-agent-protocol-traffic)

## Test skeleton

Supply `makeFixture` using the real owner and read layers. Its provider stub models lag and catches up when instructed. Each replay gets fresh state and closes it even when an assertion fails.

```ts
import fc from "fast-check";
import { expect, it } from "vitest";

type Command =
  | { kind: "rename"; name: string }
  | { kind: "catchUp" }
  | { kind: "read" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("rename" as const), name: fc.constantFrom("First", "Second") }),
  fc.constant({ kind: "catchUp" as const }),
  fc.constant({ kind: "read" as const }),
);
type Scenario = [listingLags: boolean, commands: Command[]];
const scenario: fc.Arbitrary<Scenario> = fc.tuple(
  fc.boolean(),
  fc.array(command, { minLength: 1, maxLength: 24, size: "max" }),
);

async function replay([listingLags, commands]: Scenario) {
  const { threadId, owner, live, provider, close } = await makeFixture({ listingLags });
  let expectedName: string | undefined;

  async function settle() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const index = await live.read();
      if (live.isCurrent(index)) return index;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Live index did not settle");
  }

  async function check(label: string) {
    const index = await settle();
    // This property begins at the first accepted rename.
    if (expectedName === undefined) return;
    expect({
      label,
      live: index.threads.find((row) => row.id === threadId)?.title,
      listed: await owner.readListedTitle(),
      cached: owner.readCachedTitle(),
      info: owner.readThreadInfoTitle(),
    }).toEqual({ label, live: expectedName, listed: expectedName, cached: expectedName, info: expectedName });
  }

  try {
    await owner.start();
    for (const [step, cmd] of commands.entries()) {
      if (cmd.kind === "rename") {
        await owner.rename(cmd.name);
        expectedName = cmd.name;
      } else if (cmd.kind === "catchUp") {
        await provider.publishListing();
      } else {
        await check(`${step}: ${cmd.kind}`);
      }
    }
    await check("final");
  } finally {
    await close();
  }
}

// Illustrative shrunk case for a listing that regresses to a placeholder after rename.
const laggingListing: Scenario = [true, [{ kind: "rename", name: "First" }, { kind: "read" }]];
it("keeps a rename visible while the listing lags", () => replay(laggingListing));

it("agrees across settled read layers", async () => {
  await fc.assert(fc.asyncProperty(scenario, replay), {
    numRuns: Number(process.env.MBT_RUNS ?? 5),
  });
});
```

## Gotchas

- In fast-check 4, `maxLength` only clamps the generated length. Use `size: "max"` or a suitable `minLength` when long sequences matter.
- Fast-check 4.10.2 counts `examples` toward `numRuns`. If you use `examples` for a local replay, set `numRuns` at least as high as the number of examples. Zero runs skip them all.
- With `fc.scheduler`, a scheduled function awaiting another scheduled function deadlocks `waitFor`. Schedule leaf steps and drain them with `waitOne`.
- For layout and overflow, assert that the content is visible as well as checking its bounds. Clipped-away content can pass an overflow check.
- CI lanes have run about 2.3× slower than a fast local Mac. Stay within the policy's file budget and well under the default 5 s timeout. Lower the run count when needed.
- From the repository root, run `nvm use`, then `pnpm exec vitest run --config vitest.workspace.mts <file>`. Redirect both streams to an ignored `.local/` log, preserve the exit status, and use `rg` to extract `Counterexample`, `seed`, `Tests`, and the relevant assertion diff. Use the failure's seed and path for local replay.
