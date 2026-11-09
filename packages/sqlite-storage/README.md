# Profile SQLite storage

This package owns PwrAgent's profile `state.db` opener, schema and migration
ladder. Desktop consumes this implementation through `main/storage`; its
state-internal compatibility exports contain no second implementation.

The shared `AppRuntimeInstanceStore` implements owner-core runtime lease ports
for profile messaging, federation and MCP connections. Desktop constructs it
through its private `main/storage` binding at the existing app-state lifecycle
site. Host liveness remains injected. PID-owned leases, immediate acquisition,
dead-owner grace and messaging side effects retain the original transactions;
no heartbeat or new write is introduced.

The schema remains at `user_version = 80`. Existing SQL, migration transactions,
convergence checks, lazy payload moves, garbage collection and write metrics
retain their original lifecycle. `state-schema.ts` also supplies table definitions
to desktop stores that have not yet moved into this package.

`better-sqlite3` is a peer dependency. Each host installs it for its own runtime;
this private package carries no native binary. Its development dependency only
supports this checkout's typechecking and tests.

Storage implementations may import `state-db`, table helpers and schema modules.
Owner/application code consumes storage ports instead. Fatal dependency rules
enforce both that privacy boundary and this package's independence from hosts,
transports and provider adapters. Owner core remains independent of SQLite.

The desktop-main test project runs the native storage tests in its existing fork
pool. `shared-sqlite-foundation.property.test.ts` checks the pre-extraction schema
oracle, generated upgrade/reopen sequences, metadata preservation, transaction
variants, rollback, cross-connection visibility and zero-write reads/reopens.

`shared-runtime-lease-storage.property.test.ts` runs an independent owner model
against real WAL connections through portable, desktop and compatibility entry
points. It covers live identity authority, persisted death and PID reuse, clock
changes, grace deadlines, all three lease kinds, profile isolation, reopen order,
atomic rollback and zero-write reads/reopens. The desktop E2E profile test also
checks Node-created lease takeover by Electron and release back to Node.
