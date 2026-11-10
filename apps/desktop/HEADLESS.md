# Node owner host

This contributor entry runs the desktop owner services under Node 24, using the
same `startOwnerServices()` root as Electron. It requires an existing PwrAgent
profile and the checkout's installed dependencies.

From the repository root:

```sh
pnpm build:headless
PWRAGENT_PROFILE=dev pnpm start:headless
```

Use a disposable profile for development. `PWRAGENT_HOME` selects the PwrAgent
root as it does for desktop. `node apps/desktop/out/headless/index.js --version`
prints the application's version without starting owners. SIGINT and SIGTERM
close the existing owner services and state database.

The build emits the main entry and separate Claude session reader, storage
maintenance, MCP bridge and token-miser hook entries. `runtime.json` beside them
records the application version and relative application/resource paths.
Packaged resources and Electron's Node helpers resolve the same bundled Git,
agent and native helper locations. The build resolves npm dependencies from the
checkout; these development outputs depend on that installation.

Desktop keeps Electron `safeStorage` and the OS keychain. Only the Node host
creates `state/headless-secret.key`, a random 32-byte AES-256-GCM key, with mode
0600 under the profile's private 0700 state directory. Keep that file with the
profile when backing it up. An existing damaged key is preserved and startup
fails with an explicit error.

Encrypted records identify their host. Opening a profile in the other host
marks its secrets unavailable and preserves their ciphertext until the operator
replaces them. Untagged legacy records belong to desktop. The Node host logs a
specific diagnostic for desktop-encrypted federation private keys; it does not
replace the identity. No secret-sharing mechanism is installed.

Renderer broadcasts, thread presentation, appearance, notifications and Star Map
presentation have no UI in this host. File pickers cancel; opening applications,
relaunch and desktop updates report that they require desktop. Trash operations
move items into the profile's `trash/` directory. Automatic storage maintenance
uses the same worker; manual maintenance waits for an interactive host without
changing its preference or recording an attempt.

`index.test.ts` compares both host factories against the recorded owner startup
order. `headless-host.boot.oracle.test.ts` builds the Node entry and boots and
shuts down its real owners in a disposable profile, with a test-owned Codex
protocol transport and the repository's agent CLI guard. Production worker,
preload and renderer entries remain covered by
`production-entry-host.oracle.test.ts`. These tests do not launch Electron.
