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

The real Outpost daemon also opens the profile database through its
`federation-core.ts` host binding. That binding returns shutdown and handle-free owner storage ports, uses the
same runtime lease manager as desktop, and holds both profile-federation and
messaging leases before starting a provider, recovering jobs or opening a
listener. Shutdown drains the runtime before releasing leases and closing the
database. The existing private headless owner lock still guards crash recovery.

Desktop's production registry admits local thread creation, turns, reviews,
automation and helpers through an owner-core application port, and guards
Codex connections, Claude session queries and pooled/ephemeral ACP startup.
The port retains a `thread_owner` claim on the existing federation lease even
when federation and messaging are disabled. Service shutdown releases only its
own claim; successful provider shutdown releases the thread-owner claim.
Failed provider shutdown retains ownership until process exit/dead-owner grace.
Passive viewers do not claim a lease. Repeated owner admissions only read it;
no schema, lock file or SQLite heartbeat is added.

`profile-runtime-markers.ts` owns the existing PID/instance/start-time marker
format, freshness checks and file heartbeat. Desktop retains its profile path
resolution and process defaults. The marker timer performs no SQLite writes;
the shared manager receives host liveness and boot time through its ports.
Outpost has its own pinned native SQLite dependency external to the JS bundle.

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
Outpost's private profile binding also supplies this handle-free port to the
same owner-core inbox service. Receipt, job, FIFO and event identities agree;
authenticated callers cannot read another issuer/device's receipts. Accepted
queued input is transient and is never restored after shutdown or recovery.

`outpost-durable-turn-write-budgets.json` measures actual feature boundaries:
queued admission is four commits/32,960 observed WAL bytes (3.296 MB/day at
100/day), direct admission seven/41,200 (4.12 MB/day), queued dispatch including
the prior terminal five/16,480 (1.648 MB/day), cancellation or native completion
two/8,240 each (0.824 MB/day), and shutdown of one active plus one queued job
three/12,360 (1.236 MB at 100 shutdowns/day). One hundred duplicate submissions
plus reads and one hundred uncertain retries plus reads each make zero commits.
Setup is excluded; no schema, timer or inherited budget changes.

`outpost-durable-steer-write-budgets.json` measures the actual Outpost steering
inbox through its existing native control path. Receipt admission, claim and
accepted result cost three commits/four statements/three changed rows with
24,720 observed WAL bytes; an uncertain native outcome has the same cost.
At 100 steers/day each projects to 2.472 MB/day. A fresh-host read settling one
stale claim costs one commit/4,120 bytes (0.412 MB/day at 100/day). One hundred
matching accepted retries plus reads and one hundred uncertain retries plus
reads each make zero commits and no native resend. Setup is excluded. Steering
adds no job, schema, timer or write to an existing accepted job's fingerprint.

`outpost-queued-steer-write-budgets.json` measures individual ordinary agent
admission through the actual owner and existing shared queue. Acceptance, native
target claim, origin retention and running confirmation cost four commits/20,600
observed WAL bytes (2.06 MB/day at 100/day). Native uncertainty costs three
commits/16,480 bytes (1.648 MB/day); refused running confirmation costs four/20,600.
One terminal settling the original job and one interjection costs two/8,240
(0.824 MB/day). Shutdown of original, steered and waiting jobs costs three/12,360;
their existing atomic recovery costs one/4,120. Each 100 matching accepted or
uncertain retries makes zero commits and no native resend. Setup is excluded.
Retiring a refused claim restored behind shutdown's first cancellation sweep
costs two commits/8,240 bytes (0.824 MB/day at 100/day), excluding acceptance.
One hundred interjection-identity interrupt refusals add zero writes or native
control calls; native interruption stays with the original active job.
The existing job payload retains a bounded delivery enum and captured native
identity, never prompt text. No schema, timer or inherited budget changes.

`outpost-held-steer-retry-write-budgets.json` measures explicit Retry after an
individual guidance entry was accepted and held before its native claim.
Successful target claim, original-owner origin retention and running confirmation
cost three commits/12,360 observed WAL bytes (1.236 MB/day at 100 retries/day).
Native uncertainty costs two commits/8,240 bytes (0.824 MB/day); confirmation
uncertainty costs three/12,360. A refused claim and each 100 duplicate or gated
retries cost zero commits and add no native resend. Shutdown after successful
Retry settles original and guidance jobs in two commits/8,240 bytes. Setup and
acceptance are excluded; real drains/timers and all inherited budgets remain
unchanged. Retry adds no persistence site or idle write.

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

The shared schema is at `user_version = 81`; the additive v81 migration installs
`owner_jobs` for durable job acceptance/outcomes on both hosts. Existing SQL, migration transactions,
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

`outpost-profile-runtime.property.test.ts` checks generated live-owner models,
actual binding cleanup on held leases and statement refusal, the handle-free
host interface, and measured lifecycle/idle budgets in the separate
`outpost-sqlite-write-budgets.json` fixture. One start/stop cycle costs six
commits, eight statements and about 95 KB of WAL; an idle hour costs zero
SQLite commits. One cycle per day projects to about 0.095 MB/day (one per hour,
about 2.28 MB/day). Schema setup is outside that measurement. The inherited
SQLite budget fixture is unchanged. Real daemon tests preserve acceptance,
explicit crash recovery and restart without replay, including the existing
60-second dead-owner grace. Supported Electron E2E observes an Outpost-held
lease, refuses its desktop federation runtime, transfers ownership to desktop,
refuses Outpost startup while desktop holds it, and transfers back after quit.

The production Outpost's JobStore and HeadlessBackend now use shared SQLite.
The job storage port retains acceptance fingerprints, confirmed thread/turn
identities and terminal outcomes without prompts or transcripts. Owner metadata
uses the existing SqliteOverlayStore registry; its synchronous storage methods
allow an atomic import while the public owner API retains async semantics.
The Outpost reads desktop's retained provider inventory separately from live
canonical owner metadata. Its metadata projection includes pins, seen watermarks,
parents, archive/model settings and creation-time messaging tool capability.

On first adoption the storage package validates the private workspace/Codex-home
identity, parses both legacy registries, and fsyncs byte-exact backups under
`headless/legacy-owner-backup-v1`. One FULL-durability immediate transaction merges
threads, imports jobs, recovers active jobs to unknown without replay, and records
a manifest. Existing canonical facts win over legacy duplicates. Only after commit
does it retire the matching legacy files. A restart completes partial retirement
from that marker, never reimports the backups, and refuses changed sources or
missing backups. Identity, project, tool-call, federation and intake files remain
private host data. Job acceptance uses FULL durability and restores the connection's
prior mode. Native packaging smoke verifies import and restart from an offline
installation with its own better-sqlite3 dependency.

The separate `outpost-owner-data-write-budgets.json` measures one multi-record
legacy import as one commit, a job lifecycle as four commits (20,600 WAL bytes),
and an actual new-thread turn as six commits (49,440 WAL bytes). At 100 such turns
per day the entire new data path projects to about 4.94 MB/day (the job portion
2.06 MB/day); 1,000 streamed events and 1,000 passive reads/reopen add zero commits.
Each changed owner metadata command commits once (12,360 WAL bytes, about
1.24 MB/day at 100 commands/day). These are boundary costs, with no idle timer.
The inherited default budget and conformance fixtures remain byte-identical.

Outpost completes fresh active/archive Codex protocol discovery before listening,
and uses the same scrubbed provider projection as this package. Unchanged reads
make no commits. Canonical titles retain the last acknowledged native name so
both hosts preserve derived provenance without hiding a later provider rename.
Legacy names remain pending owner facts until the shared naming lifecycle
publishes them to Codex. The acknowledgement is an optional overlay JSON field,
with no schema change. Desktop persists it through its actual name-event bus
for derived names and changes to existing canonical titles. Ordinary explicit
names remain provider-owned and add no title-metadata commit; an existing Agent
name still uses its one inherited overlay commit. Navigation projects canonical
titles from the compact overlay rows it already loaded, without rereading full
rows or transcript histories.

`outpost-profile-parity-write-budgets.json` measures one changed inventory as one
commit/8,240 WAL bytes (about 0.00824 MB/day at one refresh/day), an Outpost native
rename as one commit/16,480 bytes (about 1.648 MB/day at 100 renames/day), and a
desktop native-title event replacing an existing canonical title as one
commit/12,360 bytes (about 1.236 MB/day at 100 events/day). One thousand unchanged discoveries and one thousand repeated title
events make zero commits. Publishing one pending imported title and its complete
inventory costs two commits/16,480 bytes (about 0.01648 MB for one such start/day).
These boundaries add no timer. Generated conformance
runs desktop → actual daemon → desktop → actual daemon over one test-owned
profile/provider, checking native names, pins, parents, seen watermarks and
archive/restore. The inherited default and conformance fixtures are unchanged.

Outpost profile reads retain backend-qualified Codex, Claude and ACP identities.
The shared `ClaudeSessionMetadataStore` reads PwrAgent-owned Claude JSON metadata,
including archives, through the same reader desktop's `ClaudeSessionStore` uses.
Its generic port leaves SDK identity and rewind metadata private to desktop;
Outpost's binding exposes only scrubbed thread summaries. Metadata reads never
open JSONL histories, rate-limit files, authentication or provider session files.
Outpost refreshes this actual metadata before profile reads without starting
Claude. A completed read replaces older retained Claude membership, including
deletions; a missing metadata directory confirms an empty inventory. Concurrent
discoveries coalesce. Sidecar names/provenance, archives and execution mode retain
authority on both hosts; shared overlay settings, pins, parents and seen watermarks
remain live. Existing metadata writes, image/history locking and SDK reads stay
at their original desktop sites. Schema 81 remains unchanged.

`outpost-claude-profile.property.test.ts` generates metadata changes and archives
without retained inventory, exercises deletion and backend isolation, and compares
the actual portable/desktop readers including malformed sidecars and ephemeral
sessions. Actual desktop/daemon conformance clears retained inventory between
owners; supported Electron coverage hands actual desktop edits to Outpost after
quit. The separate `outpost-claude-profile-write-budgets.json` measures 100 metadata
save/discovery boundaries and 1,000 passive read rounds as zero SQLite commits,
statements, rows and WAL bytes: incremental 0 MB/day. No SQLite timer is added.

Claude inventories use the same supported-backend codec as the other providers.
Actual ACP session metadata (including archives and uninstalled backends) is read
through the shared session port, rather than inferred from an older startup
inventory. That store also owns membership: a deleted or hidden session cannot
resolve from an older inventory or a retained overlay. Desktop startup hydration
and refresh publication use actual ACP membership, including agents with no
installed record. Native titles/provenance, workspace, times and execution mode
outrank older overlay facts. Native archive state applies without a durable
owner archive/restore observation; a passive stored session cannot supersede
that observation. Live pins, parents, seen watermarks and model settings remain
shared. Desktop cache publication reapplies the ordinary directory/environment
enrichment, then rechecks native membership after its IO. The separate
`acp-cache-enrichment-write-budgets.json` records the existing first worktree
mapping commit (16,480 WAL bytes, about 1.648 MB/day at 100 new resolutions);
100 repeated publications and 1,000 cached reads add zero writes.
Hidden helpers remain excluded. Desktop and Outpost use the same pure
ACP summary projection; host path labels stay injected. Unsupported providers
are listed as unavailable and their execution, transcript and mutation requests
are refused before reaching Codex. This grants no cross-instance reach.

Desktop native name events update an existing non-Codex inventory row only when
its title or provenance changes. They do not create incomplete inventories or
change membership freshness. Reserved owner observation sequences prevent a late
provider list from restoring an older name. Desktop startup reads use compact
overlay batches to project canonical Codex titles over retained inventories;
only a fresh provider response may contradict a native acknowledgement.

`outpost-provider-read-write-budgets.json` measures one Claude inventory boundary
as one commit/8,272 WAL bytes (about 0.008272 MB/day at one/day), a one-time legacy
Claude scrub as one commit/4,120 bytes, and each changed Claude or ACP native name
as one commit/4,120 bytes (about 0.412 MB/day at 100/day). One thousand repeated
native events and one thousand rounds of retained profile reads, including actual
ACP discovery, make zero commits. No timer or schema change is added. Generated
actual-owner conformance checks colliding Codex/Claude/ACP identities, native
names, late lists and metadata through desktop → daemon → desktop. Supported
Electron verifies that desktop ACP renames and archives reach the actual Outpost
registry without launching an ACP process.

`outpost-acp-membership.property.test.ts` checks generated native save/delete,
hidden-helper, stale-inventory/overlay and owner-reopen sequences against an
independent membership model, with colliding backend IDs and native metadata
authority. Actual desktop/daemon conformance covers native deletion followed by
stale retained reads and restart on each host. Supported Electron coverage reads
active, archived and uninstalled ACP members before handing native retirement to
Outpost. The installed package smoke also checks ACP retirement without losing a
colliding Claude record. The separate `outpost-acp-membership-write-budgets.json`
measures the existing native delete as one commit/12,360 WAL bytes (about
1.236 MB/day at 100 deletions/day), and 1,000 absent read rounds plus ten registry
reopens as zero commits. Membership projection adds no SQLite write or timer:
incremental 0 MB/day. The inherited default and conformance fixtures are unchanged.

Complete Codex active/archive discovery now retires previously confirmed native
identities independently of their retained owner metadata. The existing inventory
storage port atomically publishes the replacement and records retirement in the
overlay JSON; no schema changes or raw handles reach the owner. A pin-only row
cannot resurrect after restart. Native creation records confirmation in its
existing commit and fences older discoveries. Pending imported owners remain
retained until native confirmation, and durable accepted jobs retain their owner
identities and unchanged fingerprints/thread/turn outcomes without replay.
Failed or incomplete walks publish neither inventory nor retirement; late events
cannot recreate an absent native member. A fresh positive discovery can restore
membership while preserving title provenance, pins, parents, seen and settings.

`outpost-codex-membership.property.test.ts` models those transitions through the
actual profile binding and owner, including overlapping reads and reopen. Actual
desktop/daemon conformance exercises repeated protocol cursors and both native
active/archive retirement. Supported Electron and the offline installed package
verify pending-import and accepted-job retention through handover. The separate
`outpost-codex-membership-write-budgets.json` records one retirement boundary as
one commit/two statements/two changed rows/16,480 observed WAL bytes (about
1.648 MB/day at 100 boundaries/day). Confirmed creation uses its existing one
commit, with 16,480 observed WAL bytes. One thousand absent discoveries, late
events and reads plus ten owner reopens add zero commits and 0 MB/day. There is
no SQLite timer; the inherited default and conformance fixtures are unchanged.

`RetainedOwnerThreadStore` supplies the same handle-free retention port to desktop
and Outpost. It reuses the canonical metadata and durable job stores. Pending
imports require the existing committed manifest and byte-verified PwrAgent backup;
an arbitrary overlay cannot establish an owner identity. Accepted jobs retain
their identity even after native retirement, without changing fingerprints,
confirmed thread/turn IDs or terminal outcomes. The projection stores no prompts or transcripts,
does not enter native inventories and starts no provider work. Unnamed imports
retain the same fallback title on both hosts.
Without a current native row, retained active/archive reads honor the same
durable `archivedAt`, `archiveRetentionStartedAt` and `restoredAt` observations,
including timestamp zero, as the owning registry.

Positive desktop native evidence confirms previously pending imports in one
transaction, checking the current metadata within that transaction so late
confirmation cannot overwrite retirement. The separate
`retained-owner-read-write-budgets.json` measures a one-identity confirmation as
one commit/one statement/one row/12,360 observed WAL bytes, and two identities as
one commit/two statements/two rows/12,360 bytes. At 100 such boundaries per day,
the measured cost projects to about 1.236 MB/day. Twenty repeated native
observations, 1,000 retained reads, ten storage reopens and an actual desktop owner
list make zero commits and 0 MB/day. No timer or schema change is added. Generated
models cover acceptance through confirmed thread/turn and terminal boundaries,
backend collisions, live canonical facts, atomic refusal and late confirmation.
Actual desktop/enrolled-daemon conformance, supported Electron and the installed
native package exercise retained reads without replaying accepted work.

Outpost's accepted first turns now use the shared title admission/generation
and naming lifecycles with the existing Codex structured helper. The immediate
prompt title retains its existing boundary; an acknowledged helper title uses
the same owner metadata port. Ephemeral helper threads, prompts and responses
never become job records or provider inventory. Explicit renames win over late
helper results; rejected or invalid helpers retain the prompt fallback.
Outpost's host policy sets approval `never` and a read-only sandbox on primary
and legacy helper starts and helper turns, without activating another provider.

`outpost-title-lifecycle.property.test.ts` exercises generated completion,
duplicate observation, explicit rename and handoff-lock orders through actual
Outpost classes. Actual desktop/enrolled-daemon conformance runs both hosts'
real structured helper client. Supported Electron and the offline installed
native package verify title handover and unchanged accepted job identities.
The separate `outpost-title-write-budgets.json` measures the new acknowledged
helper title as one commit/one statement/one changed row/12,360 observed WAL
bytes: about 1.236 MB/day at 100 new-thread titles/day. The immediate fallback
retains its existing one commit/12,360 bytes; 1,000 repeated turn observations
and owner reads make zero commits. Admission and shutdown add no write or timer.
The inherited default budget and conformance baseline remain byte-identical.

Outpost's actual federation and job-created native threads now use the existing
shared creation coordinator, and accepted jobs use shared turn submission and
finalization. Host construction, durable acceptance/fingerprints and confirmed
identity/outcome writes remain at their existing sites. Observer failures cannot
reject committed acceptance; a refused confirmed-turn write preserves the known
provider identity as unknown without replay. Native membership is observed before
creation metadata finalization, so metadata refusal cannot hide provider success.

`outpost-creation-turn-lifecycle.property.test.ts` generates host-port refusals,
observer failures, terminal orderings and duplicate submissions through the actual
Runtime/HeadlessBackend with real profile storage. Supported Electron hands an
actually created/submitted job and helper title to desktop after a refused viewer
finalizer. The separate `outpost-creation-turn-write-budgets.json` measures native
federation creation as 1 commit/16,480 observed WAL bytes (1.648 MB/day at 100/day),
an accepted existing-thread turn as 5 commits/28,840 bytes (2.884 MB/day at 100/day),
and a new-thread turn as the inherited 6 commits/49,440 bytes (4.944 MB/day at
100/day). A refused turn-confirmation write uses 4 commits/32,960 bytes including
the unknown outcome boundary (3.296 MB/day at 100/day). One thousand duplicate
submissions and owner reads add zero commits and 0 MB/day. There is no SQLite
timer; all inherited budgets and conformance defaults remain byte-identical.

Outpost steering now uses shared request admission and submission. Native
acceptance precedes the existing job-origin write; concurrent retries share
completion and a failed origin write never resends accepted input. Runtime
interruption uses shared target coordination and retains its existing durable
interrupting/refusal-restoration sites. Concurrent provider terminals win over
late restoration or origin completion, and retire steering admission.

`outpost-turn-control-write-budgets.json` measures actual feature boundaries:
an accepted origin or interrupt commits once (4,120 observed WAL bytes, about
0.412 MB/day at 100/day). Refused interrupts and interrupts with a concurrent
terminal commit twice (8,240 bytes, about 0.824 MB/day at 100/day). A refused
origin write commits zero times; its completion retry commits once. Ordinary
steering, 1,000 accepted steering retries/reads, and 1,000 repeated pending
interrupts commit zero times and add no provider sends. Setup is excluded;
there is no timer, and every inherited budget remains byte-identical.

Outpost's executable Runtime now admits continued-thread jobs through the
shared `ThreadTurnQueue`. Acceptance records `queued` in the existing owner-job
payload before inference; input remains transient. Dispatch uses the existing
turn lifecycle and one daemon-global provider slot. Queued jobs recover to
`unknown` in the same recovery transaction as active jobs, without restoring
input or replaying a provider call. No schema change is needed.

`outpost-turn-queue-write-budgets.json` measures acceptance as one commit/8,240
observed WAL bytes (0.824 MB/day at 100/day), cancellation as one/4,120
(0.412 MB/day), and prior completion plus queued dispatch/confirmation/completion
as five/16,480 (1.648 MB/day). Native and confirmation refusal each cost three
commits/8,240 bytes (0.824 MB/day); a handoff-lock refusal makes no writes.
Graceful shutdown of one active and one queued job costs two commits/8,240
bytes; crash recovery settles both in one transaction/4,120 bytes. An acceptance
observer that immediately stops the host costs two commits/12,360 bytes
(1.236 MB/day at 100/day). One thousand matching retries and queue projections
make zero commits. There is no SQLite timer. Every inherited budget and the
historical conformance snapshot remain byte-identical; live conformance now
requires the queue identity/event differences in that snapshot to stay fixed.

Outpost's real owner methods and CLI now release held entries and cancel waiting
entries through that same queue. Release rechecks live ownership, workspace,
handoff and daemon gates and the immutable acceptance fingerprint. Cancellation
suspends shared dispatch and commits its terminal job outcome before removing
the entry. A refused write leaves input waiting; an admitted provider turn is
never interrupted by queue cancellation. Restart restores neither input nor
retryable entries.

`outpost-held-queue-control-write-budgets.json` measures explicit release as
three existing dispatch commits/8,240 observed WAL bytes (0.824 MB/day at
100 releases/day), excluding acceptance and completion. Cancellation costs
one commit/4,120 bytes (0.412 MB/day at 100/day). One thousand duplicate
release/cancel/projection requests and one thousand gated retries each make
zero commits and add no provider sends. There is no SQLite timer, schema
change or change to inherited budgets or the historical conformance snapshot.

Outpost's existing queued-input read now returns detached full text/origin
snapshots and a content hash. The viewer cancels that hash before editing in its
local draft and submits changed text with a new identity. The separate
`outpost-queued-input-write-budgets.json` measures 1,000 actual owner reads
(including `forEdit`) and 1,000 stale-hash cancellation refusals as zero commits,
statements, rows and WAL bytes: incremental 0 MB/day. Accepted fingerprints,
cancellation write costs, shutdown and restart without replay are unchanged.
