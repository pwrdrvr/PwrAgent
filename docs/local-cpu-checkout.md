# Local CPU checkout

Use `resource_checkout_discover` on the host running the work. Continue with the same parallelism limits if checkout tools or the resource are unavailable. Workloads absent from this list need no reservation. For counted resources, set `units` to the CPU budget below. For exclusive resources, request a checkout only above 33% of the host’s available logical CPUs.

- Unit tests — Start with 4 CPUs and `pnpm test --maxWorkers=4`. Set `--maxWorkers` to match the reservation and add `--project shared` for a focused run.
- Desktop E2E — Budget 4 CPUs for `pnpm --filter @pwragent/desktop test:e2e:prebuilt --workers=1`. `pnpm test:desktop-e2e` also builds the app, so use the uncapped budget below.
- Lint — Budget 4 CPUs for `OXLINT_THREADS=4 pnpm lint:oxlint` or `OXLINT_THREADS=2 GOMAXPROCS=2 pnpm lint:oxlint:typed`. For plain `pnpm lint`, use the uncapped budget.
- Typecheck — Budget 4 CPUs for `GOMAXPROCS=4 pnpm -r --workspace-concurrency=1 --if-present typecheck`. This runs one native TypeScript compiler at a time.
- Builds — For a Rust build, start with 8 CPUs and `cargo build --jobs 8`. If a listed workload may saturate the host and has no effective cap, reserve all but two CPUs, such as 16 of 18 or 12 of 14.

1. Send `resource_checkout_action` with `kind: "request"`, the discovered `resourceId`, a short `purpose`, an `expectedDurationMs` that covers the run, and an `idempotencyKey`. Set `units` to the CPU count for a counted resource and omit it for an exclusive resource.
2. Start only after the request is granted. If it queues, use `resource_checkout_status` with the original request key to check for promotion. Cancel an unneeded queued request with `kind: "cancel_request"` and its `queueEntryId`. Apply the parallelism cap in the command itself. A shell checkout coordinates with other PwrAgent checkouts, and shell CPU use is outside broker enforcement.
3. After the workload exits, even on failure, send `kind: "release"` with the resource ID, granted `allocationId` and `generation`, and a separate idempotency key for the release. Check that the request status is `ended`. If a tool call has an unknown result, check its receipt or retry with the same key.
