# Local CPU checkout

Use `resource_checkout_discover` to find the machine compute resource for the host where the command will run. If the tools or a matching resource are unavailable, use explicit local parallelism limits. If discovery reports `sharing.mode: "counted"`, request the CPU units your bounded workload can use. If the resource is exclusive, request it only when the workload is expected to use more than 33% of the host’s available logical CPUs.

- For four single-threaded Vitest workers, request `units: 4` and run `pnpm test --project shared --maxWorkers=4`. On an 18-CPU host, this workload runs without an exclusive checkout.
- For a Rust build bounded to eight Cargo jobs with `cargo build --jobs 8`, request eight units on a counted resource or an exclusive checkout on an 18-CPU host. Account for subprocesses and internal threading when sizing the workload.

1. Send `resource_checkout_action` with `kind: "request"`, the discovered `resourceId`, a short `purpose`, an `expectedDurationMs` that covers the run, and an `idempotencyKey`. Set `units` to the CPU count for a counted resource and omit it for an exclusive resource.
2. Start only after the request is granted. If it queues, use `resource_checkout_status` with the original request key to check for promotion. Cancel an unneeded queued request with `kind: "cancel_request"` and its `queueEntryId`. Apply the parallelism cap in the command itself. A shell checkout coordinates with other PwrAgent checkouts, and shell CPU use is outside broker enforcement.
3. After the workload exits, even on failure, send `kind: "release"` with the resource ID, granted `allocationId` and `generation`, and a separate idempotency key for the release. Check that the request status is `ended`. If a tool call has an unknown result, check its receipt or retry with the same key.
