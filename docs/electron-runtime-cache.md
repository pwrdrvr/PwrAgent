# Electron runtime extraction cache

The desktop lifecycle hook `apps/desktop/scripts/ensure-electron-runtime.mjs`
installs an independent runtime into the current worktree's Electron package.
It reuses verified extracted artifacts under
`$PWRAGENT_HOME/cache/electron-runtime/v1` (default
`~/.pwragent/cache/electron-runtime/v1`). It never shares a mutable
`node_modules` directory or links workspace packages to another checkout.

PwrGit and PwrSnap can consume the same cache by retaining this exact default
directory, format and identity fields; the product name is not part of the key.
Application state directories remain independent. An explicit `PWRAGENT_HOME`
override also isolates the cache, which disposable tests rely on.

Both `.codex/environments/environment.toml` setup variants reach this installer
through ordinary `pnpm install` and the desktop postinstall hook. The default
POSIX setup serves macOS and Linux; Windows uses its PowerShell bootstrap and
`& $pnpmCommand install`. Neither setup performs a separate Electron download or
disables lifecycle scripts. Regression tests protect that chain, and a native
entry-point test exercises three different project layouts against one cache.

## Why pnpm did not share these files

The 2026-11-10 read-only audit supplied for this investigation found 92 Electron
dist directories in 78 of 80 PwrAgnt worktrees. They occupied 30,740,647,936
listed allocated bytes and 29,045,542,912 private bytes measured with macOS
`getattrlist(ATTR_CMNEXT_PRIVATESIZE)`, with zero read errors. Ordinary pnpm
imports and unchanged tracked source already shared APFS extents.

The installed Electron 44.10.1 package has no lifecycle scripts; it exposes
`install-electron` as a CLI. PwrAgent's desktop workspace postinstall performs
the extraction into that dependency's `dist/`. pnpm's side-effects cache saves
the package whose dependency build ran; it does not capture a workspace hook's
writes into a different package. `sideEffectsCache: true` and `allowBuilds:
electron: true` therefore cannot make these extracted bytes shareable. See
[pnpm's build settings](https://pnpm.io/settings/build#sideeffectscache).
The locally installed `@electron/get` 5.1.0 validates cached ZIPs as well as
downloads, but its download cache stores ZIPs, not extracted runtimes.

A disposable pnpm 12.13.0 experiment confirmed the boundary with two projects,
one isolated shared store, `sideEffectsCache: true`, and a scriptless tarball
dependency. Both workspace postinstall hooks observed that the dependency's
generated payload was absent before creating it; the second import did not
restore the first workspace hook's output.

## Installation and integrity

Each cache key hashes the format version, Electron version, requested platform,
requested architecture and verified ZIP SHA-256. Existing download options,
mirrors, force-download setting, cache root and remote-checksum setting still
go through `@electron/get`. The installer additionally compares the ZIP against
the package's bundled checksum when available.

An extraction is prepared in a unique staging directory. Its runtime version,
executable and complete inventory of file hashes, modes, directories and
relative symlink targets are checked before publication. Escaping symlinks are
rejected. Publication uses directory rename; simultaneous publishers clone the
verified winner. Cache hits are rehashed. Invalid existing cache entries are
preserved for diagnosis and bypassed. An unavailable cache permits a normal
local extraction.

Worktree-only write permissions are supported. Download and checksum temporary
files live in an owned directory inside the current Electron package. If the
ZIP cache rejects a write with `EACCES`, `EPERM` or `EROFS`, the installer makes
one attempt with a ZIP cache inside that same temporary directory. Both attempts
retain `@electron/get` checksum validation and download settings. Network and
integrity failures do not trigger this permission fallback. The entry-point
download callback must forward the installer's `tempDirectory` and optional
`cacheRoot` overrides after its default download options.

A readable, verified shared extraction can still be cloned without modifying
the shared cache. When shared storage cannot be used, installation remains
local and may allocate a private runtime. Download scratch and its local ZIP
cache are removed after installation; no existing user cache is removed.

The runtime is cloned into a separate staging directory inside the target
Electron package, rehashed, and then published. `path.txt` is written last.
Type definitions remain available in the package root. A complete install is
verified and reused offline without consulting the cache. Changing any target
dimension, changing a bundled checksum, or damaging the installed runtime
requires reinstallation. Legacy installs acquire the manifest on their next
explicit lifecycle invocation; this change does not scan or migrate worktrees.

Installers targeting the same package serialize through a nonempty lock
directory published with an owner PID and unique token. Recovery requires the
OS to confirm that the owner PID is absent. It removes only that owner's token
and an empty lock directory, so racing successors cannot delete a live lock.
A live owner is never displaced based on age. Waiting fails after two minutes.
PID reuse conservatively leaves the lock held. Ordinary failures remove only
the current installer's temporary paths; a forcibly killed process can leave
its staging directory behind.

On macOS, `/bin/cp -cRpP` makes native APFS clones and preserves framework
symlinks. Other filesystems use Node's clone request, with independent byte
copies as fallback. Node 24.22.1's `COPYFILE_FICLONE` alone did **not** clone on
the measured Mac. Equal hashes and different inodes were insufficient evidence.
Filesystems or volumes without clone support retain correctness and isolation
but incur private allocation.

## Reproduce the headless APFS measurement

Use an already cached ZIP matching the installed Electron version and host
architecture:

```sh
node apps/desktop/scripts/probe-electron-runtime-sharing.mjs \
  /absolute/path/to/electron-v44.10.1-darwin-arm64.zip \
  .local/electron-sharing-report.json
```

The probe verifies the bundled release checksum, creates two ordinary
extractions and two concurrent cloned installs in its own disposable directory,
and compiles the small `getattrlist` oracle in
`apps/desktop/scripts/fixtures/apfs-private-size.c`. It checks that every
requested metadata field was returned. It measures all regular runtime files,
then changes a cloned Framework file to prove write isolation. It launches no
GUI, touches no existing runtime/cache, retains the JSON report, and removes
only its own disposable directory.

Measured on 2026-11-10 with Node 24.22.1, Electron 44.10.1, darwin/arm64:

| Copy | Regular runtime files | Private bytes |
| --- | ---: | ---: |
| Independent extraction A | 260 | 323,747,840 |
| Independent extraction B | 260 | 323,723,264 |
| Cloned install A | 260 | 0 |
| Cloned install B | 260 | 0 |

The four Framework files shared SHA-256
`8ce4d847c7b56f2a37a3083ab5f09ac54061f267390a7f9d44e341bb83ef9241`
and had four distinct inodes. The extraction clone IDs differed; the installed
clones both had clone ID `236190110` and zero private bytes. Writing 4 KiB into
one installed clone allocated 16,384 private bytes and changed its hash while
the other clone's hash and zero private allocation stayed unchanged. A separate
Node `copyFileSync(COPYFILE_FICLONE)` of that Framework used 204,095,488 private
bytes. These are filesystem observations, not `du` estimates.

The filesystem oracle test failed against the original installer at commit
`077481127` because the independently extracted files had different clone IDs.
The fixed installer passes it. The test suite also uses generated target
combinations and cache mutations to check partitioning and corruption rejection,
and OS process ownership to check interrupted-install recovery. Concurrent
process tests cover separate worktrees and multiple installers of one package.

```sh
pnpm test apps/desktop/scripts/ensure-electron-runtime.test.mjs
```

The APFS-specific oracle runs on macOS; the partitioning, integrity, lifecycle
and concurrency tests run on other supported hosts too. Cross-target fixtures
check selection and isolation; they do not execute foreign binaries.

## Retention assessment

No existing worktrees, builds, caches or user scratch data were cleaned during
this investigation. Future clone installs avoid duplicate runtime extents;
existing private allocations are not retroactively reclaimed.

| Audit surface | Bytes | Worktrees | Current policy observed |
| --- | ---: | ---: | --- |
| Vitest caches | 6,607,142,912 | 74 | Per-worktree cache; no repository byte/age cap |
| Desktop `out/` | 6,527,275,008 | 67 | Per-worktree build output |
| `.local` | 2,023,743,488 | 78 | Mixed scratch, evidence and potentially unique user data |

Vitest 5.0.5's filesystem cache defaults to `node_modules/.vitest-cache`.
The installed implementation invalidates it on lockfile changes; it does not
implement a repository retention budget. Its explicit
[`--clearCache`](https://vitest.dev/guide/cli#clearcache) operation also clears
other Vitest caches. It was not run during this investigation.

The six-entry limit in `scripts/ci/desktop-out-cache.mjs` applies only to its
explicit CI cache, not each worktree's `apps/desktop/out`. Worktree output may
belong to a running application or an active test. `.local` is not uniformly
reproducible and cannot safely be treated as a disposable cache.

The audit counted 75 Electron 44.9.3 installs, 14 of 44.10.1, and one each of
41.10.5, 41.7.1 and 41.10.3. Their consumers must be identified before selecting
retained versions. The new extraction cache deliberately performs no automatic
eviction; a cache entry can be shared by active independent installs. Retention
work is tracked on this thread's to-do cards, with a dry-run inventory and
active-consumer protection required before any deletion proposal.
