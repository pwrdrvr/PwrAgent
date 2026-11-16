# Protocol stdout framing audit

JSON-RPC stdio is UTF-8 NDJSON. Only LF delimits frames; CRLF is accepted.
U+2028/U+2029 are legal JSON string contents, and byte chunks may split any
UTF-8 character. `node:readline` splits those separators on Node 24.22.1 and
must not frame protocol stdout.

The owning source of `@pwrdrvr/agent-transport` is
`pwrdrvr/agent-kit`, `packages/agent-transport` (confirmed by its package
repository metadata and Git origin). The source fix exports
`readJsonRpcLines`, released in `@pwrdrvr/agent-transport@0.1.8`. Desktop and
owner-core require that release; the workspace override keeps transitive
agent-client/discovery consumers on the same version. The release-age
exception is scoped to first-party version 0.1.8. No dependency patch is needed.

## Callers

| Reader | Resolution |
| --- | --- |
| Desktop Codex stdout | Shared LF reader; auth-envelope inspection unchanged |
| Desktop ACP stdout | Shared LF reader; stderr preview and owned process tree teardown unchanged |
| Outpost | Its build bundles the same desktop owner/transports through `buildHeadless`; no separate stdout framer |
| Shared transport | Published 0.1.8 applies to desktop, owner-core and transitive consumers |
| Kimi chatty probe, portable-discovery probe, live camera probe | Shared LF reader |
| Renderer bytecode checker | Shared LF reader for JSON stdin and stdout marker/disassembly records |
| Windows native pipe diagnostics probe | Shared LF reader for watcher JSON stdout |
| Claude CLI fixture property | Shared LF reader feeding an async object stream |

Remaining `readline` sites were classified rather than broadly replaced:
Codex stderr is human diagnostics with existing severity/rate-limit handling;
`attempt-lifecycle.mjs` reads a repository-owned file; process-descendants
reads a numeric PID; messaging-controller's socket fixture is not stdout.
Other test/e2e fixtures read stdin. Python's archive lab `stdout.readline()`
uses LF framing and does not split Unicode separators. The ACP SDK's
NDJSON `LineBuffer` scans LF bytes and is covered in agent-kit.

## Verification

On Node 24.22.1 the caller property failed on the first generated case for
both unfixed desktop Codex and ACP readers. Both shrank to an empty arbitrary
string plus the Unicode sentinel sent one byte at a time. The Codex reader
split the frame; ACP's JSON-RPC parser discarded the fragments. The fixed
callers pass with arbitrary UTF-16 strings, byte partitions, LF/CRLF and EOF
tails. A separate property exercises the installed shared package over real
fixture subprocess pipes. Existing transport suites verify stderr behavior
and owned process shutdown. Outpost's normal build/test command verifies the
bundled path. See agent-kit's `docs/stdio-framing.md` for its pre-fix oracle
failure and synthetic 1,295,500-byte response test.

No Codex private rollouts, sessions or databases are used as fixtures. Checks
launch only disposable test-owned processes; no shared App Server is stopped
or restarted.
