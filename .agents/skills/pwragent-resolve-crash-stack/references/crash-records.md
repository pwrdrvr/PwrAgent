# Same-record crash identity proposal

Observed in checkout `6d8b1727a` (2026-10-03); recheck the named code before recommending implementation. This reference is separate from stack mapping and does not authorize product changes.

- `apps/desktop/src/renderer/src/lib/renderer-error-reporting.ts:createRendererErrorReport` captures message/name/stack, ErrorEvent filename/lineno/colno, href, timestamp, userAgent and optional React componentStack. The report itself lacks version/build identity.
- `apps/desktop/src/main/ipc/renderer-error.ts:registerRendererErrorIpcHandlers` destructures **both stack and componentStack out** before `rendererErrorLog.error("report", summary)`.
- `apps/desktop/src/main/index.ts` logs `app starting` with `app.getVersion()`, Electron version, process.platform and process.arch. This is a separate record, so a pasted error record loses identity.
- Its boot `unhandledRejection` handler logs message/reason and bootCompleted, without the Error's stack or same-record version.
- `apps/desktop/src/main/window.ts` logs `renderer process gone` with Electron reason/exit details, not a JS stack. A process-gone event cannot fabricate one.
- `apps/desktop/src/main/app-build-identity.ts:readAppBuildIdentity` returns only `{kind:"packaged"}` for packaged apps; the development-only Git commit is not release provenance. `process.arch` does not identify universal vs arm64 packaging.

Recommended same-record shape at the **main-process logging boundary**, using trusted main-process identity rather than renderer-asserted version fields:

```ts
{
  event: "renderer-error",
  timestamp: report.timestamp,
  processType: "renderer",
  source: report.source,
  message: report.message,
  name: report.name,
  stack: report.stack,
  componentStack: report.componentStack,
  generatedLocation: {
    filename: report.filename,
    line: report.lineno,
    column: report.colno,
    columnBase: 1,
  },
  app: {
    version: app.getVersion(),
    platform: process.platform,
    runtimeArch: process.arch,
    electron: process.versions.electron,
    isPackaged: app.isPackaged,
  },
  // Proposed embedded release metadata; unavailable fields stay explicit null.
  build: {
    packageArch: null,
    releaseTag: null,
    commit: null,
    ciRunId: null,
    ciRunAttempt: null,
    generatedFiles: null, // [{path, bytes, sha256}] for relevant installed JS
  },
}
```

The `app` fields above already have real APIs. `build` would need a deliberately embedded packaging-time identity manifest; the current packaged `AppBuildIdentity` does not supply those fields. Hash exact installed JS at capture boundaries or reuse trustworthy packaged hashes, avoiding per-event full hashing or persistence writes. Keep full generated paths and column convention. Apply a deliberate diagnostic redaction/size policy to stack URLs and source text without discarding the useful frames. Do not invent a commit or package target from the runtime architecture or checkout. For main exceptions/rejections use `reason instanceof Error ? reason.stack : undefined`; for native process loss retain reason/exitCode with identity and leave stack absent. Product logging implementation belongs in its own authorized change, coordinated with the parent incident-diagnostics work.
