# Messaging review picker property exceeds five seconds under survey I/O

## Result

The property `preserves the Auto-fix choice under any sequence of toggles and picker navigation`
repeatedly exercises a real JSON-backed `MessagingStore`. Its 25 examples can accumulate
thousands of serialized file operations while the write-budget survey runs other files.
The five-second failure is reproducible in those store operations. Controller settlement
accounts for milliseconds, rather than the seconds consumed by the store.

Use a fresh `openInMemoryStateDb()` and the real `SqliteMessagingStore` for each generated
example. This property asserts picker state and the submitted review request; it does not
assert reopening, cross-connection visibility, file semantics, or a write budget. Each
example settles controller work before closing its connection in `finally`, including
failed examples and shrinking. The nearby persistence and Auto-fix write-budget tests
continue to use their existing stores.

## Provenance and scope

- Reported commit: `930a99daf7a852db7003736c2cee7730adc456b1`, test at line 1129.
- Original evidence: `/private/tmp/pwragent-acp-reminder-timeout/.local/acp-reminder-timeout/green-survey.log`
  and `picker-isolated.log`. The 99-file survey timed out at 5,085 ms; 4,548 tests passed,
  one failed, and two were skipped. The isolated invocation passed in 1.89 seconds overall.
- Investigation worktree: `/private/tmp/pwragent-picker-timeout`, branch
  `fix/messaging-picker-property-lifecycle`.
- Fetched `origin` and based the work on main at
  `daaa9b04af59d457ec92b494926289311959ec8f`. The property is unchanged between the
  reported commit and that main. Current main selects 101 budget files and 4,595 tests.
- All experiments used Node v24.22.1 with native socket and `os.uptime` fixture permissions.
- The separate MCP HTTP shutdown and owner metadata fixes were not applied or edited.
- SSH-signed diagnostic checkpoint: `402b359a2`. Its temporary probes and fixed seed are
  removed from the final tree.

## Failure mechanism and controlled comparison

The diagnostic checkpoint wraps only this property's `MessagingStore.readData` and
`writeData`. It counts calls and elapsed awaited time, and measures controller settlement.
The private store queue serializes its operations. Each read loads and migrates the JSON;
each write creates the directory, writes a temporary JSON file, and renames it over the
store. These operations are unnecessary for the state-machine assertion.

Both diagnostic fixtures use fast-check seed `20261110`, 25 runs, and arrays of up to six
steps drawn from the original toggle, scope, mode, and reviewer operations. The fixed
fixture uses the same generated inputs and assertions.

| Experiment | Outcome | Property diagnostics |
| --- | --- | --- |
| Original fixture, isolated | Passed | 25 examples, 125 picker actions; 1,275 reads in 99 ms and 675 writes in 164 ms; body 342 ms; settlement 0.57 ms |
| Original fixture, full 101-file survey | Timed out at 5,042 ms | Eventual diagnostic sample: 23 example entries, 1,142 reads in 647 ms and 608 writes in 4,281 ms; elapsed 5,484 ms; settlement 1.69 ms |
| Original fixture, isolated with 3 ms added per JSON read/write | Timed out at 5,000 ms | Latency injected only at the store boundary; runner settings unchanged |
| In-memory SQLite fixture, same seed and 3 ms JSON-store injection | Passed | All 25 examples and 125 picker actions; zero JSON reads/writes; body 137 ms |
| In-memory SQLite fixture, same seed, full survey | Passed | All 25 examples and 125 picker actions; zero JSON reads/writes; body 1,145 ms; settlement 0.52 ms |

The timeout and diagnostic elapsed time are separate measurements: the latter is recorded
when the property's diagnostic `finally` executes. The final sample from a timed-out run
is not a count of completed successful examples. The original store awaits consumed
about 4.93 seconds of that sample, versus less than two milliseconds in settlement.
The added-latency failure and the identical-input replacement passing with zero JSON-store
calls establish the I/O dependency. The original log has no operation-level timing, so
these experiments establish the reproducible mechanism rather than reconstructing the
original run's exact scheduling or random seed.

## Validation

Every survey generated its arguments using exactly:

```python
paths = subprocess.check_output([
    "rg", "-l", "expectSqliteWriteBudget",
    "apps/desktop/src/main/__tests__", "-g", "*.test.ts",
], text=True).splitlines()
subprocess.run(["pnpm", "test:sqlite-writes", *paths], check=True)
```

No path was filtered out. The final run additionally selected default and JSON reporters
to capture individual durations. Timeouts, worker counts, process isolation, retries,
fast-check run count, maximum sequence length, generated operations, and assertions remain
unchanged in the final patch. The diagnostic seed and latency injection are absent.

| Run | Outcome |
| --- | --- |
| Unmodified current-main survey | 101 files passed; 4,593 tests passed, two skipped; 97.02 s |
| Original fixture with diagnostics, full survey | Only the picker property failed; 4,592 passed, two skipped; 80.89 s |
| Replacement with diagnostics, full survey | 101 files passed; 4,593 tests passed, two skipped; 81.06 s |
| Final patch, no probes or fixed seed, full survey | 101 files passed; 4,593 tests passed, two skipped; 81.71 s; picker property 1,009 ms |
| `pnpm lint:eslint` (both Oxlint passes) | Exit 0; zero errors; 407 warning lines, none in the changed test |
| `pnpm typecheck` | Exit 0 |

There were no write-budget mismatches and no budget changes. This is a fixture-only change;
no production persistence or write frequency changes.

Logs, selected path lists, timing JSONL, and the final survey's JSON report are under
`/private/tmp/pwragent-picker-timeout/.local/picker-timeout/`. The final survey is reproducible
on this machine with `python3 .local/picker-timeout/run-survey.py`. Survey warnings include
the Vite native-config compatibility advisory, Git worktree preparation output, and Claude
SDK tool-approval warnings; none affected the final exit status.
