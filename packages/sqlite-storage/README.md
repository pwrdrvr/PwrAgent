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

Shared `MessagingPairingStore` and `MessagingActivityLog` implement owner-core
pairing and activity ports. Desktop's private bindings retain both original
explicit factories and app-state construction sites. Profile-secret generation,
qualified HMACs and timing-safe matching, expiry/approval transitions, activity
payloads, response freshness, list bounds and retention keep their existing SQL
and write counts. Sharing storage grants no messaging or federation access.

Shared `OperatorRequestStore` implements the owner-core operator-request port.
Desktop's private concrete binding and separate application factory retain the
original service-construction lifecycle. First-record identity, pending question
text and immediate closed-text retirement, first-seen times, batched seen writes
and retention of open question/to-do/review marks keep their original SQL and
transactions. Pending server requests remain owned by the live registry.

Shared generic `SqliteTokenMiserStorage` implements the existing owner-core
accounting port. Its private desktop binding retains the actual runtime factory
and service construction. Metadata/observation identities, ordering, conditional
payload writes, archive generations, immediate legacy import and exclusive
transactions keep their original SQL. The service still owns safe accounting
projection, filesystem migration/cleanup, replay buffers and temporary originals.

Shared generic `AcpAgentStore` implements the existing owner-core ACP agent
port over scalar index constraints. Registry policy, launch descriptors and
capabilities remain opaque host payloads. Desktop's private specialization
retains the original explicit factory and service/backend construction sites.
Registry cache replacement, backend identity, NOCASE ordering, JSON failure and
legacy payload guards, SQL and write counts are unchanged.

Shared generic `SqliteMessagingRequestStore` implements the existing owner-core
request port over an injected host projection. Messaging admission, bounded
credential-scrubbed routing snapshots and destination policy remain with the
host. The private desktop specialization retains the original explicit factory
and controller construction. Profile-file authority, hash inputs, immutable
requests, monotone destination pointers, keyset pages and attachment outcomes
preserve their SQL, transactions and write counts. No messaging-interface
dependency enters this package.

Shared generic `SqliteMessagingStore` implements the existing owner-core
messaging port over persistence index constraints and injected host policy.
Desktop's private specialization retains original app-state construction and
accessor lifetime. Channel/default-Agent lookup, migration, matching, merges,
credential scrubbing and snapshot versioning stay in the host policy, which
receives no database handle. The separate in-memory store shares only its pure
questionnaire predicate. All SQL and transaction sites remain unchanged.

Shared `FederationStore` owns profile peer trust, enrollment HMACs and session
audit persistence. Shared records and the complete handle-free port live in
`shared`; federation retains its narrow transport port and compatibility exports.
The private desktop binding and original explicit factory preserve construction,
revocation/reauthorization, expiry, repeat collapse, SQL and exact write counts.
No access policy or native binary is shared.

Shared `ThreadSandboxStore` implements owner-core pending thread-resource
storage. Its private desktop binding preserves the gateway observer's event-time
state guard and the original explicitly typed cleanup factory. First-creator
ownership, unqualified native grants, pending-status filters, cleanup ordering
and stale outcomes keep every SQL statement and exact write count. This does
not activate a provider or move viewer-local composer drafts into owner state.

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

`shared-messaging-storage.property.test.ts` compares independent pairing,
HMAC/security and activity models across portable/desktop WAL connections and
reopens. It checks profile isolation, transition/expiry gates, detached payloads,
bounded cursors, monotone freshness, per-origin retention, atomic rollback and
unchanged write counts. Supported Electron E2E reads portable pairing/activity
facts through real desktop services, generates and dismisses local requests,
then hands the persisted mutations back to Node with messaging disabled.

`shared-operator-request-storage.property.test.ts` compares independent question,
seen and open-work retention models across portable/desktop WAL connections and
reopens. It checks backend/thread/message qualification, first-record/first-seen
identity, exact deadlines, open-review preservation, closure privacy, atomic
rollback, malformed payloads, detached reads and unchanged write counts.
Supported Electron E2E hands portable pending questions and old seen marks to the
real desktop service, then reads its mutations after graceful shutdown.

`shared-token-miser-storage.property.test.ts` compares independent object,
observation and retention models across portable/desktop WAL connections and
reopens. It checks actual factory binding, immutable index identity, conditional
writes, duplicate import/archive precedence, migration markers, immediate locking,
atomic rollback, malformed/no-repair reads and exact commit counts. Generated
service coverage retains content privacy, buffered replay and failed-flush retry.
Supported Electron E2E reads portable accounting through the real Settings
service and observes later portable commits through that retained service. The
profile retains migration markers and archive fences; after Electron shutdown,
the portable service restores the thread without resurrecting original output.

`shared-acp-agent-storage.property.test.ts` compares independent backend/index,
latest-cache and ordering models across portable/desktop WAL connections and
reopens. It checks actual factory binding, arbitrary host payloads, permissive
legacy guards, malformed/no-repair reads, detached results, atomic rollback and
exact commit counts. Supported Electron E2E hands portable registry/agent records
to real Settings services, observes a later portable replacement, and reads
acknowledged updates back through portable storage after graceful shutdown.

`shared-messaging-request-storage.property.test.ts` checks the actual factory's
retained binding, arbitrary alternate-host JSON, independent identity and
latest-human models across WAL connections/reopens, bounded keyset pages,
copied-profile exclusion, first attachment outcomes, privacy, rollback and exact
commits. Supported Electron E2E bundles the original factory with test-owned
profile selection and its native dependency, observes portable provenance and
later WAL commits, and returns immutable outcomes to Node after shutdown.
No messaging adapter or real conversation is activated by that fixture.

`shared-messaging-store.property.test.ts` checks actual app-state construction,
independent binding/observation/default-Agent/expiry/topic models across WAL
connections and reopens, callback authorization, browse and revoke cleanup,
federated identity, malformed reads, legacy migration, serialization/transaction
refusal and exact unchanged commits. An independent host supplies arbitrary
channel names, opaque JSON and its own snapshot shape. Supported Electron E2E
hands portable routes to the actual desktop services, observes later portable
WAL changes and verifies route retirement and cleanup from Node after shutdown.

`shared-federation-storage.property.test.ts` checks the actual factory, independent
trust/enrollment/audit models, profile HMAC oracles, WAL/reopen, rollback/refusal,
legacy records, bounded reads and exact writes. Supported Electron E2E hands
portable trust/audit facts to production IPC services, observes later WAL writes,
and reads desktop revocation and locally generated invitations back from Node.

`shared-thread-resource-storage.property.test.ts` checks both actual desktop
construction paths and their profile/guard lifetime against the shared class.
Independent resource models cover first ownership, connection-qualified identity,
native grants, cleanup/no-resurrection, detached and zero-write reads, WAL/reopen,
outer rollback/statement refusal, legacy status filters and exact unchanged commits.
Supported isolated Electron E2E runs those factories and the real cleanup service
with an invented transport, observes later portable WAL commits through a retained
port, and hands persisted cleanup outcomes back to Node after graceful shutdown.
