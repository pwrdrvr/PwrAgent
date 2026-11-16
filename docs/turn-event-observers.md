# Ordered turn-event observers

PWR-148 starts from main `c56bff20ea68e785592b0c70e89e79cab8243ffa`.
The Linear brief's method sizes and offsets are historical. Run
`node scripts/inventory-turn-event-observers.mjs --output <directory>` to
reproduce the AST/checker inventory. The baseline scan covers 3,705 source
files, all hub branches, calls, mutations, awaits, returns and exception
boundaries, construction getters, hosts, named and inline test casts,
spies, overrides, prototypes, plain objects and intersected store optionality.
Full evidence is written under `.local/pwr-148/`; stdout contains counts only.
Use `--ref c56bff20ea68e785592b0c70e89e79cab8243ffa` for the baseline;
the compiler host reads that revision without changing working files. The
inventory includes property reads inside catchable regions, branch ancestry,
the ordered registration expressions and the recorded hook ownership table.

The observable oracle is the listener boundary: registration exists before a
start is delivered, and matching terminals retire registration and execution
ownership before delivery. Valid provider sessions, redeliveries and concurrent
threads exercise that projection without calling the state reducer in the
model. The protected phase 2 recording independently fixes hook order, emitted
events and real SQLite effects. Existing review, compaction, process-exit and
activity models cover the same production owners. The terminal-before-start-
registration and late-mode counterexamples in `docs/codex-turn-state.md` remain
separate from this intended-behavior oracle.

| Contract | Normal CI coverage |
| --- | --- |
| Ordered emitted events, hook order and persistence | `turn-event-stream.test.ts`, all SQLite-budget tests |
| Codex, Claude and ACP sessions, repeated terminals, concurrent threads | `turn-event-observable.property.test.ts` |
| Fixed registration, dispatch, awaited effects, consumed deliveries and concurrent frames | `turn-event-observer.property.test.ts` |
| Each registered observer's effects, status boundaries, late ports and pricing failure boundary | `turn-event-observers.test.ts` |
| Delayed start bookkeeping, delayed mode reads and native inner/outer correlation | `codex-turn-terminal-ordering.property.test.ts` |
| Review admission, compaction ownership, scoped process exits and cleanup | `codex-thread-activity.property.test.ts`, `registry-turn-state.property.test.ts`, review and runtime supervisor suites |

Each notification gets its own delivery frame. Observers execute in the fixed
order in `backend-registry-wiring.ts`. A handler can transform the event, await
work, start detached work, throw, or return false to consume the entire delivery.
Non-lifecycle events still reach the all-event observers. No blanket catch or
notification serialization is introduced. Ingress captures and disposes Codex
start receipts exactly as before; terminal evidence can retire a receipt while
an earlier observer awaits. Mode resolution still checks registration identity.

Domain owners contribute stages rather than one callback containing all their
effects: review forwarding precedes message attribution, review completion
precedes activity retirement, and review draining follows it. Usage's terminal
transaction keeps its existing pricing finally boundary and native-subagent
usage collaborator. This preserves the interleaving between domains without
making one domain call every other domain.

Store getters still resolve against the same wrapped overlay store at call
time. Observer construction reads no host or store ports. This is an in-memory
structural change: additional commits per event and incremental write volume
are zero (**0 MB/day**). Neither protected fixture may be updated.

The archive publication-log test now settles one macrotask after its final
listener receipt. That receipt precedes the publisher's return from awaited
delivery and its synchronous log statement. The original assertion passed on
main and failed after introducing the observer return boundary; the test now
waits for that continuation without polling, retries or a longer timeout.

Run `node scripts/mutate-turn-event-observers.mjs --baseline` to replay the
final observable model against the pre-move production tree, restoring sources
in `finally`. That model passes on both trees. Run the script without flags
for the 15 deliberate order, effect, await, error-boundary, port, caller and
race mutations; `--only <pattern>` selects a subset. Every mutation must fail
an assertion. Build/import failures and missing-owner TypeErrors fail the proof
run instead of counting as detection. Both protected hashes are checked after
each mutation. Logs and generated counterexamples stay in `.local/pwr-148/`.
