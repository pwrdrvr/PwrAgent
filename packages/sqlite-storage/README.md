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

The shared `ThreadTodoStore` and `SqliteThreadReviewStorage` implement owner-core
to-do and review storage ports. Their private desktop bindings keep the existing
construction sites. Model-settings recents move with the to-do dispatch closure;
the desktop recents service and state compatibility export use the same helper.
Card edits, checklist/status updates, dispatch preferences, review tracking and
exclusive transactions retain their existing SQL and write counts.

The shared `SqliteOverlayStore` implements `OwnerThreadRegistry`, PR storage and
remote thread routing ports. Its complete closure includes dependency storage,
relative pin ordering, change-version readers and process-local environment
output. Desktop constructs the same class through a private storage binding at
the original app-state lifecycle site. State compatibility exports contain no
second implementation. The detached PR key policy and remote target port live
in owner-core without any storage dependency. All overlay SQL and transaction
bodies are preserved.

Shared `ThreadSearchStore` and `ProviderThreadSnapshotStore` retain compact
search projections and provider inventories. Desktop's private bindings use
these implementations at the existing runtime factory sites, returning
owner-core storage ports. The SQLite FTS query builder lives with its store;
the provider snapshot record and port live in owner-core. Inventory scrubbing,
search refresh/prune transactions and retained usage titles keep their existing
behavior and write counts.

Shared `AutomationStore` implements owner-core automation storage, including run
lifecycle, artifacts, pruning and startup reconciliation. Desktop's private
binding injects the existing warning logger at the same app-state construction
site. The pure transcript merge policy lives in owner-core and serves both
storage and desktop artifact rebuilding. SQL and transaction sites are preserved.

Shared `ScheduledThreadActionStore` implements owner-core scheduled-action
storage with its file/memory payload stores. Desktop's private binding retains
the original app-state construction site. Immutable payload files remain beside
the profile database; legacy inline payload moves, compare-and-set cleanup,
claims/recovery, bounded projection cursors and transactions are preserved.

Shared `SqliteDurableTurnRequestStore` implements the owner-core durable inbox
port. Its private desktop binding retains the existing federation factory and
synchronous FULL/immediate receipt and claim commits before dispatch. The prior
connection durability mode is restored on success or refusal. Receipt SQL,
caller/request/queue identities, expiry and transaction sites are unchanged.

Shared `AcpSessionStore` and `AcpAvailableCommandsStore` implement owner-core
ACP session metadata and last-observed command ports. Desktop's private bindings
retain both explicitly typed runtime factories and their app-state construction
sites. Stored backend ownership, history stripping and legacy history markers,
archive identity-keyset pages, command filtering, SQL and write counts remain unchanged.

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

`shared-todo-review-storage.property.test.ts` compares public card and review
records with independent models across portable/desktop WAL connections and
reopens. It checks backend-qualified ownership, ordering, dispatch recents,
transaction rollback, zero-write reads and unchanged dispatch commit counts.

`shared-owner-metadata-storage.property.test.ts` checks the portable binding,
independent metadata/pin/dependency models over alternating WAL connections,
reopen order, unchanged-fact/read write counts, cross-store rollback and live
output boundary writes. The supported profile E2E hands owner metadata from
Node to Electron's real services and back to Node after graceful shutdown.

`shared-inventory-search-storage.property.test.ts` compares inventory and search
facts with independent provider models across WAL connections and reopen order.
It covers backend-qualified identities, filters, pruning, detached results,
legacy scrubbing, atomic inventory/document/FTS rollback and unchanged writes.

`shared-automation-storage.property.test.ts` runs independent lifecycle and
transcript models across shared/desktop WAL connections and reopens, with
backend identity, pruning, reconciliation/outer rollback, host warnings and
unchanged write counts. Supported profile E2E hands portable automations and
artifacts to Electron's real services and reads its mutations after shutdown.

`shared-scheduled-action-storage.property.test.ts` compares independent claim
models across portable/desktop WAL connections and reopens, with backend
identity, exact writes, payload cleanup/failure, legacy migration and bounded
cursor oracles. Supported profile E2E hands portable scheduled payloads and
claims to the real desktop services and reads their mutations after shutdown.

`shared-durable-receipt-storage.property.test.ts` compares an independent inbox
model across shared/desktop WAL connections and reopens. It checks rollback,
caller isolation, expiry, write counts, immediate locking, durability restoration
and committed claims observed from a second handle before provider dispatch.
Supported Electron E2E reads portable receipts through the real federation
owner, reconciles stale claims, deduplicates a new submission and reads the
persisted results from Node after graceful shutdown.

`shared-acp-session-storage.property.test.ts` compares independent session,
history-privacy, archive-page and command models across portable/desktop WAL
connections and reopens. It checks detached reads, malformed and legacy payloads,
atomic session/command visibility, rollback and exact unchanged write counts.
Supported Electron E2E reads portable ACP metadata and commands through the real
desktop services, applies provider/owner updates, and hands them back to Node.
