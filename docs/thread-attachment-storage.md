# Thread attachment storage

Attachment lifetime follows thread ownership. Assets admitted to a thread live
under its active PwrAgent profile:

```text
state/thread-assets/<encoded-provider>/<encoded-thread-id>/<sha256>/<filename>
```

Queue admission creates the destination thread's asset paths before delivery.
This keeps a queued message readable when its source thread is deleted. Turn
submission and steering also claim ownership for callers that bypass the queue.
Per-thread admission reservations preserve submission order while retaining
bytes. They release when the queue claims a position, before the provider
response, and do not block admissions to other threads.
Inline ACP images keep their provider payload shape; their retained copies use
the same asset ownership model.

Matching explicit composer file references are rewritten with owned paths.
Managed PDF preparation can therefore redact the consumed reference before
backend delivery and lifecycle title generation. Other links and literal paths
in the prompt are unchanged.

PwrAgent-owned assets are immutable. Forwarding on the same filesystem creates
a hardlink to the destination's own path. If linking is unavailable, a
copy-on-write clone is attempted, with Node's normal-copy fallback. External
files are cloned/copied first, so editing an external original cannot alter
retained bytes. Repairs replace a path atomically instead of writing through a
shared inode.

Permanent provider deletion removes that thread's asset directory and its
`thread-images` preview cache. Archiving retains both. Removing one thread's
hardlinks does not affect the links held by another thread. Cleanup makes no
SQLite writes and does not enumerate other threads' asset directories.
Successful family deletion cleans every known descendant before forgetting
archive state, including when child deletion notifications were missed.

Uploads staged before a thread identity is known use `state/attachment-staging`.
These transient files retain seven-day expiry. Upload-triggered cleanup is
limited to once per hour and serializes with writers for the directory being
examined. Owned assets are outside that sweep. Federation receiver staging
keeps its existing expiry policy.

## Existing attachment paths

Historical `image-inputs` and `turn-input-attachments` paths remain readable.
History reads promote referenced images into the reading thread's asset folder.
An already-promoted reference uses a direct filename lookup; images already
owned by that thread bypass retention work entirely. Renderer re-renders do not
run migration or asset scans.

Legacy shared files in `image-inputs` and `turn-input-attachments` expire
30 days after their last write. Successful uploads trigger a background sweep
at most once per hour, including uploads stored directly under thread ownership.
Cleanup checks each file's write time, preserves newer neighbors, and removes
empty digest buckets. It does not follow symlinks or scan other profiles.
Thread-owned assets retain their permanent-deletion lifecycle, and unowned
staging retains its seven-day expiry.

There is no required migration before legacy expiry. Historical references
that were not promoted before their shared files expire can become unavailable.
New uploads do not grow the legacy stores. Product code does not inspect
provider rollouts.
